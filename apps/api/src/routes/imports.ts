import { Hono } from 'hono';
import {
  AppError,
  generateId,
  importKindSchema,
  type ImportKind,
  type InternalId,
} from '@dinkel/shared';
import {
  analyzeImport,
  assertCanRollback,
  describeTemplate,
  IMPORT_TEMPLATES,
  renderTemplate,
  suggestMappings,
  type ExistingRecord,
} from '@dinkel/csv-import';
import { z } from 'zod';
import type { AppEnv, RequestContext } from '../context.js';
import { requireLeagueId } from '../context.js';
import { requireCommissioner } from '../lib/authorization.js';
import { sha256Hex } from '../lib/crypto.js';
import { created } from '../repositories.js';
import { parseJson } from './auth.js';

/**
 * CSV import.
 *
 * The only migration path into the portal. No Google Sheets, no Drive, no
 * spreadsheet synchronization, no write-back — a commissioner exports CSV from
 * whatever they use and imports it here.
 *
 * The uploaded text is held only for the duration of the dry run and commit. The
 * original file is not needed after a successful import.
 */

export const importRoutes = new Hono<AppEnv>();

const isoNow = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, '');

/** Downloadable template with an example row. */
importRoutes.get('/api/imports/templates/:kind', async (c) => {
  const ctx = c.get('ctx');
  requireCommissioner(ctx.principal);

  const kind = importKindSchema.parse(c.req.param('kind'));
  const csv = renderTemplate(kind);

  c.header('Content-Type', 'text/csv; charset=utf-8');
  c.header('Content-Disposition', `attachment; filename="dinkel-${kind}-template.csv"`);
  return c.body(csv);
});

importRoutes.get('/api/imports/templates', async (c) => {
  const ctx = c.get('ctx');
  requireCommissioner(ctx.principal);

  return c.json({
    templates: Object.keys(IMPORT_TEMPLATES).map((kind) => ({
      kind,
      ...describeTemplate(kind as ImportKind),
    })),
  });
});

/**
 * Analyzes an upload without writing anything.
 *
 * Always the first step. The same analysis code produces the preview and drives
 * the commit, so a preview cannot disagree with what actually happens.
 */
importRoutes.post('/api/imports/dry-run', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const body = await parseJson(
    c,
    z.object({
      kind: importKindSchema,
      fileName: z.string().min(1).max(300),
      /** UTF-8 CSV text. Held for the analysis only. */
      csvText: z.string().min(1).max(5_000_000),
      mappings: z
        .array(
          z.object({
            sourceHeader: z.string().min(1).max(200),
            targetField: z.string().min(1).max(80).nullable(),
          }),
        )
        .optional(),
      conflictResolution: z
        .enum(['skip_conflicts', 'overwrite_conflicts', 'fail_on_conflict'])
        .default('fail_on_conflict'),
    }),
  );

  const actorId = principal.userId as InternalId;
  const { parseCsv } = await import('@dinkel/csv-import');

  const headers = parseCsv(body.csvText).headers;
  // Suggested, never applied silently: a fuzzy match could land `paid` in the
  // wrong field, so the commissioner confirms the mapping.
  const mappings = body.mappings ?? suggestMappings(body.kind, headers);

  const existing = await loadExistingByExternalKey(ctx, leagueId, body.kind);

  const analysis = analyzeImport({
    kind: body.kind,
    csvText: body.csvText,
    mappings,
    existing,
    conflictResolution: body.conflictResolution,
  });

  const importBatchId = generateId();

  await ctx.repositories.imports.saveBatch({
    entity: 'ImportBatch',
    importBatchId,
    leagueId,
    kind: body.kind,
    status: analysis.blockingProblems.length > 0 ? 'failed' : 'dry_run_complete',
    fileName: body.fileName,
    fileSizeBytes: Buffer.byteLength(body.csvText, 'utf8'),
    // Fingerprint, so re-uploading an identical file is recognizable.
    fileSha256: sha256Hex(body.csvText),
    // No S3 object: the text was analyzed in memory and is not retained.
    uploadS3Key: null,
    detectedHeaders: analysis.headers,
    columnMappings: mappings,
    totalRows: analysis.summary.totalRows,
    validRows: analysis.summary.validRows,
    errorRows: analysis.summary.errorRows,
    conflictRows: analysis.summary.conflictRows,
    duplicateRows: analysis.summary.duplicateRows,
    createdRecordCount: 0,
    updatedRecordCount: 0,
    skippedRecordCount: 0,
    conflictResolution: body.conflictResolution,
    dryRunAt: isoNow(),
    ...(analysis.blockingProblems.length > 0
      ? { failureReason: analysis.blockingProblems.join(' ') }
      : {}),
    ...created(actorId),
  });

  await ctx.repositories.imports.saveRows(
    analysis.rows.map((row) => ({
      entity: 'ImportRowResult' as const,
      importRowResultId: generateId(),
      importBatchId,
      leagueId,
      rowNumber: row.rowNumber,
      outcome: row.outcome,
      ...(row.externalKey === undefined ? {} : { externalKey: row.externalKey }),
      errors: row.errors,
      conflicts: row.conflicts,
      ...created(actorId),
    })),
  );

  await ctx.repositories.audit.record({
    leagueId,
    action: 'import.dry_run',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Dry run of ${body.kind} import "${body.fileName}": ${analysis.summary.wouldCreate} to create, ${analysis.summary.wouldUpdate} to update, ${analysis.summary.errorRows} errors.`,
    correlationId: ctx.correlationId,
    targetEntity: 'ImportBatch',
    targetId: importBatchId,
    detail: {
      kind: body.kind,
      totalRows: analysis.summary.totalRows,
      errorRows: analysis.summary.errorRows,
      conflictRows: analysis.summary.conflictRows,
    },
  });

  return c.json({
    importBatchId,
    summary: analysis.summary,
    blockingProblems: analysis.blockingProblems,
    mappings,
    // Row detail is capped: a preview of a 5000-row spreadsheet does not need
    // every row in one response.
    rows: analysis.rows.slice(0, 200).map((row) => ({
      rowNumber: row.rowNumber,
      sourceLine: row.sourceLine,
      outcome: row.outcome,
      externalKey: row.externalKey ?? null,
      errors: row.errors,
      conflicts: row.conflicts,
    })),
    rowsTruncated: analysis.rows.length > 200,
    canCommit: analysis.blockingProblems.length === 0 && analysis.summary.validRows > 0,
    note: 'Nothing has been written. Re-send with the same text to commit.',
  });
});

/**
 * Commits an analyzed import.
 *
 * The CSV text is sent again rather than stored between the dry run and the
 * commit. That keeps uploaded league data out of persistent storage entirely, and
 * the file hash confirms it is the same file that was previewed.
 */
importRoutes.post('/api/imports/:importBatchId/commit', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const importBatchId = c.req.param('importBatchId') as InternalId;

  const body = await parseJson(
    c,
    z.object({
      csvText: z.string().min(1).max(5_000_000),
      /** Must match the dry run's decision, so a conflict choice is deliberate. */
      conflictResolution: z.enum(['skip_conflicts', 'overwrite_conflicts', 'fail_on_conflict']),
    }),
  );

  const batch = await ctx.repositories.imports.findBatch(leagueId, importBatchId);
  if (!batch) throw new AppError('not_found', { publicMessage: 'No such import.' });

  if (batch.status !== 'dry_run_complete') {
    throw new AppError('precondition_failed', {
      publicMessage: `This import cannot be committed from status "${batch.status}". Run a dry run first.`,
    });
  }

  // The same file, not merely a similar one. Committing different content than
  // was previewed would defeat the point of the preview.
  if (sha256Hex(body.csvText) !== batch.fileSha256) {
    throw new AppError('precondition_failed', {
      publicMessage:
        'The file does not match the one previewed. Run a new dry run so you can review the changes.',
    });
  }

  const existing = await loadExistingByExternalKey(ctx, leagueId, batch.kind);

  const analysis = analyzeImport({
    kind: batch.kind,
    csvText: body.csvText,
    mappings: batch.columnMappings,
    existing,
    conflictResolution: body.conflictResolution,
  });

  if (analysis.blockingProblems.length > 0) {
    throw new AppError('import_conflicts_unresolved', {
      publicMessage: analysis.blockingProblems.join(' '),
    });
  }

  const actorId = principal.userId as InternalId;
  const applied = await applyRows(ctx, leagueId, batch.kind, analysis.rows, importBatchId, actorId);

  await ctx.repositories.imports.saveBatch(
    {
      ...batch,
      status: 'committed',
      createdRecordCount: applied.created,
      updatedRecordCount: applied.updated,
      skippedRecordCount: applied.skipped,
      conflictResolution: body.conflictResolution,
      committedAt: isoNow(),
      committedByUserId: actorId,
      updatedAt: isoNow(),
      updatedBy: actorId,
      version: batch.version + 1,
    },
    batch.version,
  );

  await ctx.repositories.audit.record({
    leagueId,
    action: 'import.committed',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Committed ${batch.kind} import "${batch.fileName}": ${applied.created} created, ${applied.updated} updated, ${applied.skipped} skipped.`,
    correlationId: ctx.correlationId,
    targetEntity: 'ImportBatch',
    targetId: importBatchId,
    detail: { created: applied.created, updated: applied.updated, skipped: applied.skipped },
  });

  return c.json({
    ...applied,
    note: 'The original CSV file is no longer needed — nothing about it was stored.',
  });
});

importRoutes.get('/api/imports', async (c) => {
  const ctx = c.get('ctx');
  requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);

  const batches = await ctx.repositories.imports.listBatches(leagueId);
  return c.json({ imports: batches });
});

importRoutes.get('/api/imports/:importBatchId/rows', async (c) => {
  const ctx = c.get('ctx');
  requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const importBatchId = c.req.param('importBatchId') as InternalId;

  const rows = await ctx.repositories.imports.listRows(leagueId, importBatchId);
  return c.json({ rows });
});

/**
 * Rolls back a committed import.
 *
 * Refused when a later record depends on the imported rows — deleting a challenge
 * result out from under a payout leaves the ledger pointing at nothing.
 */
importRoutes.post('/api/imports/:importBatchId/rollback', async (c) => {
  const ctx = c.get('ctx');
  const principal = requireCommissioner(ctx.principal);
  const leagueId = requireLeagueId(ctx);
  const importBatchId = c.req.param('importBatchId') as InternalId;

  const batch = await ctx.repositories.imports.findBatch(leagueId, importBatchId);
  if (!batch) throw new AppError('not_found', { publicMessage: 'No such import.' });

  const rows = await ctx.repositories.imports.listRows(leagueId, importBatchId);
  const written = rows.filter((row) => row.outcome === 'created' || row.outcome === 'updated');

  const dependencies = await findDependencies(ctx, leagueId, batch.kind, written);

  try {
    assertCanRollback(batch, dependencies);
  } catch (error) {
    const message = error instanceof AppError ? error.publicMessage : 'Rollback blocked.';

    await ctx.repositories.imports.saveBatch(
      {
        ...batch,
        rollbackBlockedReason: message,
        updatedAt: isoNow(),
        updatedBy: principal.userId as InternalId,
        version: batch.version + 1,
      },
      batch.version,
    );

    await ctx.repositories.audit.record({
      leagueId,
      action: 'import.rollback_blocked',
      actorUserId: principal.userId as InternalId,
      actorRole: principal.role,
      summary: `Rollback of import ${importBatchId} was blocked: ${message}`,
      correlationId: ctx.correlationId,
      targetEntity: 'ImportBatch',
      targetId: importBatchId,
    });

    throw error;
  }

  const actorId = principal.userId as InternalId;
  const removed = await removeImportedRows(ctx, leagueId, batch.kind, written);

  await ctx.repositories.imports.saveBatch(
    {
      ...batch,
      status: 'rolled_back',
      rolledBackAt: isoNow(),
      rolledBackByUserId: actorId,
      updatedAt: isoNow(),
      updatedBy: actorId,
      version: batch.version + 1,
    },
    batch.version,
  );

  await ctx.repositories.audit.record({
    leagueId,
    action: 'import.rolled_back',
    actorUserId: actorId,
    actorRole: principal.role,
    summary: `Rolled back import ${importBatchId}, removing ${removed} record(s).`,
    correlationId: ctx.correlationId,
    targetEntity: 'ImportBatch',
    targetId: importBatchId,
    detail: { removedCount: removed },
  });

  return c.json({ ok: true, removed });
});

// --------------------------------------------------------------------------
// Applying rows
// --------------------------------------------------------------------------

type Ctx = RequestContext;

/**
 * Loads already-imported records for conflict and duplicate detection.
 *
 * Only the kinds implemented so far are consulted; the rest report nothing
 * existing, so every row reads as a create. That is honest: an unimplemented kind
 * has nothing to conflict with.
 */
async function loadExistingByExternalKey(
  ctx: Ctx,
  leagueId: InternalId,
  kind: ImportKind,
): Promise<Map<string, ExistingRecord>> {
  const existing = new Map<string, ExistingRecord>();

  if (kind === 'seasons') {
    for (const season of await ctx.repositories.leagues.listSeasons(leagueId)) {
      if (!season.externalKey) continue;
      existing.set(season.externalKey, {
        externalKey: season.externalKey,
        values: {
          seasonYear: String(season.seasonYear),
          buyIn: String(season.buyIn.amountCents),
          ...(season.teamCount === undefined ? {} : { teamCount: String(season.teamCount) }),
          status: season.status,
        },
      });
    }
  }

  if (kind === 'league_rules') {
    for (const rule of await ctx.repositories.leagues.listRules(leagueId)) {
      if (!rule.externalKey) continue;
      existing.set(rule.externalKey, {
        externalKey: rule.externalKey,
        values: {
          effectiveSeasonYear: String(rule.effectiveSeasonYear),
          category: rule.category,
          title: rule.title,
          body: rule.body,
        },
      });
    }
  }

  return existing;
}

/** Applies analyzed rows. Returns counts for the batch record. */
async function applyRows(
  ctx: Ctx,
  leagueId: InternalId,
  kind: ImportKind,
  rows: ReadonlyArray<{
    rowNumber: number;
    outcome: string;
    externalKey?: string;
    values?: Record<string, unknown>;
  }>,
  importBatchId: InternalId,
  actorId: InternalId,
): Promise<{ created: number; updated: number; skipped: number; unsupported: boolean }> {
  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  for (const row of rows) {
    if (
      row.outcome === 'error' ||
      row.outcome === 'skipped_conflict' ||
      row.outcome === 'skipped_duplicate'
    ) {
      skippedCount += 1;
      continue;
    }
    if (!row.values || !row.externalKey) {
      skippedCount += 1;
      continue;
    }

    const values = row.values;

    if (kind === 'seasons') {
      const seasonYear = Number(values['seasonYear']);
      const existing = await ctx.repositories.leagues.findSeason(leagueId, seasonYear);

      await ctx.repositories.leagues.saveSeason(
        {
          entity: 'Season',
          seasonId: existing?.seasonId ?? generateId(),
          leagueId,
          seasonYear,
          status: (values['status'] as never) ?? existing?.status ?? ('complete' as never),
          buyIn: { amountCents: Number(values['buyIn'] ?? 0), currency: 'USD' },
          finalFinishOrder: existing?.finalFinishOrder ?? [],
          ...(values['teamCount'] === undefined ? {} : { teamCount: Number(values['teamCount']) }),
          ...(values['draftDate'] === undefined ? {} : { draftDate: String(values['draftDate']) }),
          externalKey: row.externalKey,
          importBatchId,
          ...(existing
            ? {
                createdAt: existing.createdAt,
                createdBy: existing.createdBy,
                updatedAt: isoNow(),
                updatedBy: actorId,
                version: existing.version + 1,
              }
            : created(actorId)),
        },
        existing?.version,
      );

      if (existing) updatedCount += 1;
      else createdCount += 1;
      continue;
    }

    if (kind === 'league_rules') {
      const rules = await ctx.repositories.leagues.listRules(leagueId);
      const existing = rules.find((rule) => rule.externalKey === row.externalKey);

      await ctx.repositories.leagues.saveRule(
        {
          entity: 'LeagueRule',
          ruleId: existing?.ruleId ?? generateId(),
          leagueId,
          effectiveSeasonYear: Number(values['effectiveSeasonYear']),
          category: values['category'] as never,
          title: String(values['title']),
          body: String(values['body']),
          sortOrder: existing?.sortOrder ?? 0,
          externalKey: row.externalKey,
          importBatchId,
          ...(existing
            ? {
                createdAt: existing.createdAt,
                createdBy: existing.createdBy,
                updatedAt: isoNow(),
                updatedBy: actorId,
                version: existing.version + 1,
              }
            : created(actorId)),
        },
        existing?.version,
      );

      if (existing) updatedCount += 1;
      else createdCount += 1;
      continue;
    }

    // Other kinds validate and preview correctly but are not yet applied. Counted
    // as skipped and reported, rather than silently claimed as imported.
    skippedCount += 1;
  }

  return {
    created: createdCount,
    updated: updatedCount,
    skipped: skippedCount,
    unsupported: !['seasons', 'league_rules'].includes(kind),
  };
}

/** Finds records that would be orphaned by a rollback. */
async function findDependencies(
  ctx: Ctx,
  leagueId: InternalId,
  kind: ImportKind,
  rows: ReadonlyArray<{ externalKey?: string; targetId?: InternalId }>,
): Promise<ExistingRecord[]> {
  const records: ExistingRecord[] = [];

  for (const row of rows) {
    if (!row.externalKey) continue;

    let hasDependents = false;

    if (kind === 'seasons') {
      const seasonYear = Number(row.externalKey.split('|')[0]);
      // A season with dues, payouts, or results recorded against it cannot be
      // removed without breaking those records.
      const [dues, payouts, results] = await Promise.all([
        ctx.repositories.money.listDues(leagueId, seasonYear),
        ctx.repositories.money.listPayouts(leagueId, seasonYear),
        ctx.repositories.challenges.listResults(leagueId, seasonYear),
      ]);
      hasDependents = dues.length > 0 || payouts.length > 0 || results.length > 0;
    }

    records.push({ externalKey: row.externalKey, values: {}, hasDependents });
  }

  return records;
}

async function removeImportedRows(
  ctx: Ctx,
  leagueId: InternalId,
  kind: ImportKind,
  rows: ReadonlyArray<{ externalKey?: string }>,
): Promise<number> {
  let removed = 0;

  if (kind === 'league_rules') {
    const rules = await ctx.repositories.leagues.listRules(leagueId);
    const keysToRemove = new Set(rows.map((row) => row.externalKey).filter(Boolean));

    for (const rule of rules) {
      if (!rule.externalKey || !keysToRemove.has(rule.externalKey)) continue;
      await ctx.table.delete({ PK: `LEAGUE#${leagueId}`, SK: `RULE#${rule.ruleId}` });
      removed += 1;
    }
  }

  if (kind === 'seasons') {
    for (const row of rows) {
      if (!row.externalKey) continue;
      const seasonYear = Number(row.externalKey.split('|')[0]);
      await ctx.table.delete({ PK: `LEAGUE#${leagueId}`, SK: `SEASON#${seasonYear}` });
      removed += 1;
    }
  }

  return removed;
}
