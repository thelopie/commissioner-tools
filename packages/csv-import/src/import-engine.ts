import { AppError, type ImportKind, type ImportRowOutcome } from '@dinkel/shared';
import { parseCsv } from './parse-csv.js';
import { IMPORT_TEMPLATES, type TemplateColumn } from './templates.js';

/**
 * The import engine.
 *
 * Pure: it decides what an import WOULD do, and the API applies the decision.
 * That split is what makes a dry run trustworthy — the same code path produces the
 * preview and the commit, so a preview cannot disagree with what actually happens.
 *
 * Guarantees:
 *   - no silent overwrite: a row that would change an existing record is a
 *     conflict, and conflicts require an explicit decision before commit
 *   - idempotent: re-importing the same file matches on external key and updates
 *     in place instead of duplicating
 *   - row-scoped errors: one bad row never fails the file
 */

export interface ColumnMappingRequest {
  sourceHeader: string;
  /** Target field, or null to ignore this column. */
  targetField: string | null;
}

export interface ExistingRecord {
  externalKey: string;
  /** Current values, keyed by target field, as display strings. */
  values: Record<string, string>;
  /** Set when another record was created from this one, blocking rollback. */
  hasDependents?: boolean;
}

export interface AnalyzeOptions {
  kind: ImportKind;
  csvText: string;
  /** Explicit mapping. Absent columns are ignored, never guessed at. */
  mappings: readonly ColumnMappingRequest[];
  /** Already-imported records, keyed by external key, for conflict detection. */
  existing: ReadonlyMap<string, ExistingRecord>;
  conflictResolution: 'skip_conflicts' | 'overwrite_conflicts' | 'fail_on_conflict';
}

export interface RowAnalysis {
  rowNumber: number;
  sourceLine: number;
  outcome: ImportRowOutcome;
  externalKey?: string;
  /** Normalized values ready to persist. Absent when the row has errors. */
  values?: Record<string, unknown>;
  errors: Array<{ field: string; message: string }>;
  conflicts: Array<{ field: string; existingValue: string; incomingValue: string }>;
}

export interface ImportAnalysis {
  kind: ImportKind;
  headers: string[];
  rows: RowAnalysis[];
  summary: {
    totalRows: number;
    validRows: number;
    errorRows: number;
    conflictRows: number;
    duplicateRows: number;
    wouldCreate: number;
    wouldUpdate: number;
  };
  /** Blocking, file-level problems. Non-empty means nothing can be committed. */
  blockingProblems: string[];
}

/**
 * Suggests a mapping by matching headers to template columns.
 *
 * A suggestion only: the commissioner confirms it. Auto-applying a fuzzy match
 * would let `paid` on a payouts sheet quietly land in the wrong field.
 */
export function suggestMappings(
  kind: ImportKind,
  headers: readonly string[],
): ColumnMappingRequest[] {
  const template = IMPORT_TEMPLATES[kind];
  const normalize = (value: string): string =>
    value
      .trim()
      .toLowerCase()
      .replace(/[\s_-]+/g, '');

  return headers.map((header) => {
    const target = template.columns.find(
      (column) =>
        normalize(column.header) === normalize(header) ||
        normalize(column.field) === normalize(header),
    );
    return { sourceHeader: header, targetField: target?.field ?? null };
  });
}

/** Validates headers against the template before any row work. */
export function validateHeaders(
  kind: ImportKind,
  headers: readonly string[],
  mappings: readonly ColumnMappingRequest[],
): string[] {
  const template = IMPORT_TEMPLATES[kind];
  const problems: string[] = [];

  const mappedFields = new Set(
    mappings
      .map((mapping) => mapping.targetField)
      .filter((field): field is string => field !== null),
  );

  for (const column of template.columns) {
    if (column.required && !mappedFields.has(column.field)) {
      problems.push(
        `Required column "${column.header}" (${column.description}) is not mapped to any column in your file.`,
      );
    }
  }

  const unknownHeaders = mappings
    .filter((mapping) => mapping.targetField !== null)
    .filter((mapping) => !template.columns.some((column) => column.field === mapping.targetField))
    .map((mapping) => mapping.targetField);

  for (const field of unknownHeaders) {
    problems.push(`"${field}" is not a field on the ${template.title} template.`);
  }

  for (const header of headers) {
    if (!mappings.some((mapping) => mapping.sourceHeader === header)) {
      problems.push(`Column "${header}" has no mapping decision — map it or mark it ignored.`);
    }
  }

  // Two columns mapped to one field is ambiguous, and picking one silently would
  // discard data the commissioner meant to import.
  const targetCounts = new Map<string, number>();
  for (const mapping of mappings) {
    if (!mapping.targetField) continue;
    targetCounts.set(mapping.targetField, (targetCounts.get(mapping.targetField) ?? 0) + 1);
  }
  for (const [field, count] of targetCounts) {
    if (count > 1) problems.push(`${count} columns are mapped to "${field}". Map only one.`);
  }

  return problems;
}

/**
 * Analyzes an import without applying it.
 *
 * @throws {AppError} only for a file that cannot be parsed at all. Everything
 *   else is reported per row, so a commissioner sees all the problems at once
 *   rather than fixing them one upload at a time.
 */
export function analyzeImport(options: AnalyzeOptions): ImportAnalysis {
  const template = IMPORT_TEMPLATES[options.kind];
  const parsed = parseCsv(options.csvText);

  const blockingProblems = validateHeaders(options.kind, parsed.headers, options.mappings);

  const fieldByHeader = new Map<string, string>();
  for (const mapping of options.mappings) {
    if (mapping.targetField) fieldByHeader.set(mapping.sourceHeader, mapping.targetField);
  }

  const columnByField = new Map<string, TemplateColumn>(
    template.columns.map((column) => [column.field, column]),
  );

  const keyFields = template.externalKeyColumns
    .map((header) => columnByField.get(headerToField(template, header))?.field)
    .filter((field): field is string => field !== undefined);

  const rows: RowAnalysis[] = [];
  const seenKeysInFile = new Map<string, number>();

  parsed.rows.forEach((row, index) => {
    const rowNumber = index + 1;
    const sourceLine = parsed.rowLineNumbers[index] ?? rowNumber + 1;

    const errors: RowAnalysis['errors'] = [];
    const values: Record<string, unknown> = {};

    for (const [header, rawValue] of Object.entries(row)) {
      const field = fieldByHeader.get(header);
      if (!field) continue;

      const column = columnByField.get(field);
      if (!column) continue;

      if (!column.required && rawValue.trim().length === 0) continue;

      const result = column.validate(rawValue);
      if (!result.ok) {
        errors.push({ field: column.header, message: result.message ?? 'is not valid' });
        continue;
      }
      if (result.value !== undefined) values[field] = result.value;
    }

    // A required field mapped but left blank is a row error, not a file error.
    for (const column of template.columns) {
      if (!column.required) continue;
      if (values[column.field] === undefined) {
        const alreadyReported = errors.some((error) => error.field === column.header);
        if (!alreadyReported) {
          errors.push({ field: column.header, message: 'is required but empty' });
        }
      }
    }

    if (errors.length > 0) {
      rows.push({ rowNumber, sourceLine, outcome: 'error', errors, conflicts: [] });
      return;
    }

    const externalKey = buildExternalKey(keyFields, values);

    // A file containing the same key twice cannot be applied coherently: the
    // second row would overwrite the first within a single import.
    const firstSeenAt = seenKeysInFile.get(externalKey);
    if (firstSeenAt !== undefined) {
      rows.push({
        rowNumber,
        sourceLine,
        outcome: 'error',
        externalKey,
        errors: [
          {
            field: template.externalKeyColumns.join(' + '),
            message: `duplicates row ${firstSeenAt} in this same file`,
          },
        ],
        conflicts: [],
      });
      return;
    }
    seenKeysInFile.set(externalKey, rowNumber);

    const existing = options.existing.get(externalKey);

    if (!existing) {
      rows.push({
        rowNumber,
        sourceLine,
        outcome: 'would_create',
        externalKey,
        values,
        errors: [],
        conflicts: [],
      });
      return;
    }

    const conflicts = detectConflicts(existing, values, columnByField);

    if (conflicts.length === 0) {
      // Same key, same values: already imported. Skipping is what makes a
      // re-import idempotent rather than a no-op update storm.
      rows.push({
        rowNumber,
        sourceLine,
        outcome: 'skipped_duplicate',
        externalKey,
        values,
        errors: [],
        conflicts: [],
      });
      return;
    }

    if (options.conflictResolution === 'overwrite_conflicts') {
      rows.push({
        rowNumber,
        sourceLine,
        outcome: 'would_update',
        externalKey,
        values,
        errors: [],
        conflicts,
      });
      return;
    }

    rows.push({
      rowNumber,
      sourceLine,
      outcome: 'skipped_conflict',
      externalKey,
      values,
      errors: [],
      conflicts,
    });
  });

  const conflictRows = rows.filter((row) => row.conflicts.length > 0).length;

  if (options.conflictResolution === 'fail_on_conflict' && conflictRows > 0) {
    blockingProblems.push(
      `${conflictRows} row(s) would change existing records. Choose whether to overwrite or skip ` +
        `them before committing — nothing is overwritten without that decision.`,
    );
  }

  return {
    kind: options.kind,
    headers: parsed.headers,
    rows,
    summary: {
      totalRows: rows.length,
      validRows: rows.filter((row) => row.outcome !== 'error').length,
      errorRows: rows.filter((row) => row.outcome === 'error').length,
      conflictRows,
      duplicateRows: rows.filter((row) => row.outcome === 'skipped_duplicate').length,
      wouldCreate: rows.filter((row) => row.outcome === 'would_create').length,
      wouldUpdate: rows.filter((row) => row.outcome === 'would_update').length,
    },
    blockingProblems,
  };
}

function headerToField(template: (typeof IMPORT_TEMPLATES)[ImportKind], header: string): string {
  return template.columns.find((column) => column.header === header)?.field ?? header;
}

/**
 * Builds the stable external key.
 *
 * Lowercased and separator-joined so `Sample Manager` and `sample manager` are
 * the same person across a decade of inconsistent spreadsheet typing.
 */
export function buildExternalKey(
  keyFields: readonly string[],
  values: Record<string, unknown>,
): string {
  return keyFields
    .map((field) =>
      String(values[field] ?? '')
        .trim()
        .toLowerCase(),
    )
    .join('|');
}

function detectConflicts(
  existing: ExistingRecord,
  incoming: Record<string, unknown>,
  columnByField: ReadonlyMap<string, TemplateColumn>,
): RowAnalysis['conflicts'] {
  const conflicts: RowAnalysis['conflicts'] = [];

  for (const [field, value] of Object.entries(incoming)) {
    const existingValue = existing.values[field];
    if (existingValue === undefined) continue;

    const incomingValue = String(value);
    if (existingValue === incomingValue) continue;

    conflicts.push({
      field: columnByField.get(field)?.header ?? field,
      existingValue,
      incomingValue,
    });
  }

  return conflicts;
}

/**
 * Decides whether a committed batch can be rolled back.
 *
 * Refuses when a later record depends on the imported rows — a payout referencing
 * an imported challenge result, for instance. Deleting the result underneath the
 * payout would leave the ledger pointing at nothing, which is worse than an
 * unwanted import.
 */
export function canRollback(
  batch: { status: string; committedAt?: string },
  importedRecords: ReadonlyArray<ExistingRecord>,
): { allowed: boolean; reason?: string } {
  if (batch.status !== 'committed') {
    return {
      allowed: false,
      reason: `Only a committed import can be rolled back (status: ${batch.status}).`,
    };
  }

  const blocked = importedRecords.filter((record) => record.hasDependents);
  if (blocked.length > 0) {
    return {
      allowed: false,
      reason:
        `${blocked.length} imported record(s) now have other records depending on them, so ` +
        `rolling back would leave those references broken. Remove the dependent records first.`,
    };
  }

  return { allowed: true };
}

/**
 * @throws {AppError} `import_rollback_blocked` with the specific reason.
 */
export function assertCanRollback(
  batch: { status: string; committedAt?: string },
  importedRecords: ReadonlyArray<ExistingRecord>,
): void {
  const decision = canRollback(batch, importedRecords);
  if (!decision.allowed) {
    throw new AppError('import_rollback_blocked', {
      publicMessage: decision.reason ?? 'This import cannot be rolled back.',
    });
  }
}
