import type { ImportKind } from '@dinkel/shared';
import { toCsv } from './parse-csv.js';
import * as v from './validators.js';

/**
 * Import templates.
 *
 * One per kind of legacy data. Templates exist so a commissioner has a known-good
 * starting point, but the importer does NOT require this exact layout: column
 * mapping is explicit at import time, so a spreadsheet with different headers in a
 * different order still imports. Requiring one rigid layout would push the work of
 * reshaping a decade-old spreadsheet onto the person least equipped to do it.
 */

export interface TemplateColumn {
  header: string;
  /** Target field on the destination entity. */
  field: string;
  required: boolean;
  description: string;
  /** Validator applied to the raw cell text. */
  validate: (raw: string) => v.FieldResult<unknown>;
  /** Example value shown in the template's sample row. */
  example: string;
}

export interface ImportTemplate {
  kind: ImportKind;
  title: string;
  description: string;
  columns: TemplateColumn[];
  /**
   * Columns forming the stable external key.
   *
   * This is what makes an import idempotent: re-importing the same file matches
   * on this key and updates in place rather than creating duplicates.
   */
  externalKeyColumns: string[];
  /** Explains, in the download, what the key means for re-imports. */
  keyExplanation: string;
}

const seasonColumn: TemplateColumn = {
  header: 'season',
  field: 'seasonYear',
  required: true,
  description: 'Four-digit season year',
  validate: v.seasonYear,
  example: '2019',
};

const managerColumn: TemplateColumn = {
  header: 'manager',
  field: 'managerName',
  required: true,
  description: 'Manager name exactly as it appears in the managers import',
  validate: (raw) => v.requiredText(raw, { max: 80 }),
  example: 'Sample Manager',
};

export const IMPORT_TEMPLATES: Record<ImportKind, ImportTemplate> = {
  seasons: {
    kind: 'seasons',
    title: 'Seasons',
    description: 'One row per season the league has played.',
    externalKeyColumns: ['season'],
    keyExplanation:
      'Keyed on season, so re-importing updates that season rather than duplicating it.',
    columns: [
      seasonColumn,
      {
        header: 'buy_in',
        field: 'buyIn',
        required: true,
        description: 'Buy-in per team. $ and commas are fine.',
        validate: v.currencyCents,
        example: '$50.00',
      },
      {
        header: 'team_count',
        field: 'teamCount',
        required: false,
        description: 'Number of teams',
        validate: (raw) => (raw.trim() ? v.integer(raw, { min: 2, max: 32 }) : { ok: true }),
        example: '12',
      },
      {
        header: 'status',
        field: 'status',
        required: false,
        description: 'planned, draft_pending, in_progress, complete, or archived',
        validate: (raw) =>
          raw.trim()
            ? v.oneOf(raw, ['planned', 'draft_pending', 'in_progress', 'complete', 'archived'])
            : { ok: true },
        example: 'complete',
      },
      {
        header: 'draft_date',
        field: 'draftDate',
        required: false,
        description: 'Draft date (YYYY-MM-DD or M/D/YYYY)',
        validate: (raw) => (raw.trim() ? v.isoDate(raw) : { ok: true }),
        example: '2019-08-25',
      },
      {
        header: 'champion',
        field: 'championManagerName',
        required: false,
        description: 'Manager who won the season',
        validate: (raw) => v.optionalText(raw, { max: 80 }),
        example: 'Sample Manager',
      },
    ],
  },

  managers: {
    kind: 'managers',
    title: 'Managers',
    description:
      'One row per manager per season. A manager who played eight seasons has eight rows, ' +
      'which is what lets the portal handle managers joining and leaving.',
    externalKeyColumns: ['season', 'manager'],
    keyExplanation: 'Keyed on season plus manager name.',
    columns: [
      seasonColumn,
      managerColumn,
      {
        header: 'team_name',
        field: 'teamNameNote',
        required: false,
        description:
          'Their team name that season, for your own reference. Stored as a Dinkel note — ' +
          'current team names always come live from Yahoo.',
        validate: (raw) => v.optionalText(raw, { max: 120 }),
        example: 'Sample Team Name',
      },
      {
        header: 'email',
        field: 'email',
        required: false,
        description: 'Optional contact address. Never used to send mail in this version.',
        validate: v.email,
        example: 'manager@example.com',
      },
      {
        header: 'active',
        field: 'isActive',
        required: false,
        description: 'Whether they were active that season (yes/no)',
        validate: (raw) => v.boolean(raw, { default: true }),
        example: 'yes',
      },
      {
        header: 'final_finish',
        field: 'finalFinish',
        required: false,
        description:
          'Where they finished that season, 1 = champion. Used to break draft-order ties ' +
          'long after Yahoo stops serving that season.',
        validate: (raw) => (raw.trim() ? v.integer(raw, { min: 1, max: 32 }) : { ok: true }),
        example: '3',
      },
    ],
  },

  league_rules: {
    kind: 'league_rules',
    title: 'League rules',
    description: 'The written agreements Yahoo cannot express.',
    externalKeyColumns: ['season', 'title'],
    keyExplanation: 'Keyed on season plus rule title.',
    columns: [
      { ...seasonColumn, header: 'effective_season', field: 'effectiveSeasonYear' },
      {
        header: 'category',
        field: 'category',
        required: true,
        description:
          'scoring, roster, waivers, trades, draft, dues, payouts, challenges, conduct, other',
        validate: (raw) =>
          v.oneOf(raw, [
            'scoring',
            'roster',
            'waivers',
            'trades',
            'draft',
            'dues',
            'payouts',
            'challenges',
            'conduct',
            'other',
          ]),
        example: 'trades',
      },
      {
        header: 'title',
        field: 'title',
        required: true,
        description: 'Short name for the rule',
        validate: (raw) => v.requiredText(raw, { max: 200 }),
        example: 'Trade deadline',
      },
      {
        header: 'rule',
        field: 'body',
        required: true,
        description: 'The rule itself. Commas and line breaks are fine inside quotes.',
        validate: (raw) => v.requiredText(raw, { max: 10_000 }),
        example: 'No trades after week 11.',
      },
    ],
  },

  prize_rules: {
    kind: 'prize_rules',
    title: 'Prize structure',
    description: 'How the pot is divided. Records only — the portal moves no money.',
    externalKeyColumns: ['season', 'name'],
    keyExplanation: 'Keyed on season plus prize name.',
    columns: [
      seasonColumn,
      {
        header: 'name',
        field: 'name',
        required: true,
        description: 'Prize name',
        validate: (raw) => v.requiredText(raw, { max: 120 }),
        example: 'Champion',
      },
      {
        header: 'kind',
        field: 'kind',
        required: true,
        description:
          'champion, runner_up, third_place, regular_season_best_record, most_points, ' +
          'weekly_challenge, last_place_penalty, other',
        validate: (raw) =>
          v.oneOf(raw, [
            'champion',
            'runner_up',
            'third_place',
            'regular_season_best_record',
            'most_points',
            'weekly_challenge',
            'last_place_penalty',
            'other',
          ]),
        example: 'champion',
      },
      {
        header: 'amount',
        field: 'amount',
        required: false,
        description: 'Fixed amount. Leave blank if using a percentage.',
        validate: (raw) => (raw.trim() ? v.currencyCents(raw) : { ok: true }),
        example: '$300.00',
      },
      {
        header: 'pool_percentage',
        field: 'poolPercentage',
        required: false,
        description: 'Share of the pot, 0–100. Leave blank if using a fixed amount.',
        validate: (raw) => (raw.trim() ? v.decimal(raw) : { ok: true }),
        example: '',
      },
    ],
  },

  weekly_challenge_definitions: {
    kind: 'weekly_challenge_definitions',
    title: 'Weekly challenge definitions',
    description:
      'Your own wording for each challenge. Importing a definition does not make it ' +
      'calculable — a challenge still needs verified Yahoo data before any math runs.',
    externalKeyColumns: ['season', 'slug'],
    keyExplanation: 'Keyed on season plus slug.',
    columns: [
      seasonColumn,
      {
        header: 'slug',
        field: 'slug',
        required: true,
        description: 'Stable id, lowercase with hyphens, e.g. one-man-army',
        validate: (raw) => {
          const result = v.requiredText(raw, { max: 60 });
          if (!result.ok) return result;
          return /^[a-z0-9-]+$/.test(result.value!)
            ? result
            : { ok: false, message: 'must be lowercase letters, digits, and hyphens only' };
        },
        example: 'one-man-army',
      },
      {
        header: 'name',
        field: 'name',
        required: true,
        description: 'Display name',
        validate: (raw) => v.requiredText(raw, { max: 120 }),
        example: 'One Man Army',
      },
      {
        header: 'description',
        field: 'description',
        required: true,
        description: 'The rule in your own words',
        validate: (raw) => v.requiredText(raw, { max: 2000 }),
        example: 'Highest-scoring starter of the week.',
      },
      {
        header: 'bench_counts',
        field: 'benchCounts',
        required: false,
        description: 'Do bench players count? (yes/no)',
        validate: (raw) => v.boolean(raw, { default: false }),
        example: 'no',
      },
      {
        header: 'prize_amount',
        field: 'prizeAmount',
        required: false,
        description: 'Weekly prize, if any',
        validate: (raw) => (raw.trim() ? v.currencyCents(raw) : { ok: true }),
        example: '$10.00',
      },
    ],
  },

  historical_challenge_winners: {
    kind: 'historical_challenge_winners',
    title: 'Historical challenge winners',
    description:
      'Past challenge results. These import as finalized records: the portal keeps the ' +
      'winner and the winning value, and needs no Yahoo data to display them later.',
    externalKeyColumns: ['season', 'week', 'slug'],
    keyExplanation:
      'Keyed on season, week, and challenge slug — one result per challenge per week.',
    columns: [
      seasonColumn,
      {
        header: 'week',
        field: 'week',
        required: true,
        description: 'Week number, 1–22',
        validate: v.weekNumber,
        example: '3',
      },
      {
        header: 'slug',
        field: 'challengeSlug',
        required: true,
        description: 'Challenge slug, matching the definitions import',
        validate: (raw) => v.requiredText(raw, { max: 60 }),
        example: 'one-man-army',
      },
      { ...managerColumn, header: 'winner', field: 'winnerManagerName' },
      {
        header: 'winning_value',
        field: 'winningValue',
        required: false,
        description: 'The score or value that won',
        validate: (raw) => (raw.trim() ? v.decimal(raw) : { ok: true }),
        example: '38.4',
      },
      {
        header: 'note',
        field: 'explanation',
        required: false,
        description: 'How it was won, if you want it recorded',
        validate: (raw) => v.optionalText(raw, { max: 2000 }),
        example: 'Sample Player scored 38.4',
      },
      {
        header: 'paid',
        field: 'paid',
        required: false,
        description: 'Was the prize paid? (yes/no)',
        validate: (raw) => v.boolean(raw, { default: false }),
        example: 'yes',
      },
    ],
  },

  dues: {
    kind: 'dues',
    title: 'Dues',
    description: 'Who owed what, and whether they paid. Bookkeeping only.',
    externalKeyColumns: ['season', 'manager'],
    keyExplanation: 'Keyed on season plus manager.',
    columns: [
      seasonColumn,
      managerColumn,
      {
        header: 'amount_owed',
        field: 'amountOwed',
        required: true,
        description: 'Amount owed',
        validate: v.currencyCents,
        example: '$50.00',
      },
      {
        header: 'amount_paid',
        field: 'amountPaid',
        required: false,
        description: 'Amount actually paid. Blank means nothing paid.',
        validate: (raw) => (raw.trim() ? v.currencyCents(raw) : { ok: true }),
        example: '$50.00',
      },
      {
        header: 'status',
        field: 'status',
        required: false,
        description: 'unpaid, partial, paid, waived, refunded. Derived from amounts if blank.',
        validate: (raw) =>
          raw.trim()
            ? v.oneOf(raw, ['unpaid', 'partial', 'paid', 'waived', 'refunded'])
            : { ok: true },
        example: 'paid',
      },
      {
        header: 'paid_date',
        field: 'paidDate',
        required: false,
        description: 'When they paid',
        validate: (raw) => (raw.trim() ? v.isoDate(raw) : { ok: true }),
        example: '2019-08-20',
      },
      {
        header: 'method',
        field: 'method',
        required: false,
        description: 'cash, venmo, zelle, paypal, check, other',
        validate: (raw) =>
          raw.trim()
            ? v.oneOf(raw, ['cash', 'venmo', 'zelle', 'paypal', 'check', 'other'])
            : { ok: true },
        example: 'venmo',
      },
    ],
  },

  payouts: {
    kind: 'payouts',
    title: 'Payouts',
    description: 'What was paid out, to whom, and why. Bookkeeping only.',
    externalKeyColumns: ['season', 'manager', 'reason'],
    keyExplanation:
      'Keyed on season, manager, and reason — one manager can receive several payouts.',
    columns: [
      seasonColumn,
      managerColumn,
      {
        header: 'reason',
        field: 'reason',
        required: true,
        description: 'What the payout was for',
        validate: (raw) => v.requiredText(raw, { max: 200 }),
        example: 'Champion',
      },
      {
        header: 'amount',
        field: 'amount',
        required: true,
        description: 'Amount paid',
        validate: v.currencyCents,
        example: '$300.00',
      },
      {
        header: 'status',
        field: 'status',
        required: false,
        description: 'unpaid, partial, paid, waived, refunded',
        validate: (raw) =>
          raw.trim()
            ? v.oneOf(raw, ['unpaid', 'partial', 'paid', 'waived', 'refunded'])
            : { ok: true },
        example: 'paid',
      },
      {
        header: 'paid_date',
        field: 'paidDate',
        required: false,
        description: 'When it was paid',
        validate: (raw) => (raw.trim() ? v.isoDate(raw) : { ok: true }),
        example: '2020-01-05',
      },
    ],
  },

  draft_history: {
    kind: 'draft_history',
    title: 'Draft history',
    description:
      'Who drafted from which slot each season, including the LLWS team they held if you ' +
      'tracked it.',
    externalKeyColumns: ['season', 'manager'],
    keyExplanation: 'Keyed on season plus manager.',
    columns: [
      seasonColumn,
      managerColumn,
      {
        header: 'draft_position',
        field: 'draftPosition',
        required: true,
        description: 'Draft slot they used, 1-based',
        validate: (raw) => v.integer(raw, { min: 1, max: 32 }),
        example: '4',
      },
      {
        header: 'selection_order',
        field: 'selectionOrder',
        required: false,
        description: 'Order in which they chose their slot, if different from the slot',
        validate: (raw) => (raw.trim() ? v.integer(raw, { min: 1, max: 32 }) : { ok: true }),
        example: '1',
      },
      {
        header: 'llws_team',
        field: 'llwsTeamName',
        required: false,
        description: 'LLWS team they were assigned',
        validate: (raw) => v.optionalText(raw, { max: 160 }),
        example: 'Sample Region — Sample Town',
      },
      {
        header: 'llws_finish',
        field: 'llwsFinishRank',
        required: false,
        description: 'Where that LLWS team finished, 1 = champion',
        validate: (raw) => (raw.trim() ? v.integer(raw, { min: 1, max: 64 }) : { ok: true }),
        example: '2',
      },
    ],
  },
};

/**
 * Renders a downloadable template.
 *
 * Includes one example row, because a header-only file leaves a commissioner
 * guessing at formats — particularly for currency and dates, where a wrong guess
 * produces row errors rather than an obvious failure.
 */
export function renderTemplate(kind: ImportKind): string {
  const template = IMPORT_TEMPLATES[kind];
  const headers = template.columns.map((column) => column.header);
  const example: Record<string, string> = {};

  for (const column of template.columns) {
    example[column.header] = column.example;
  }

  return toCsv(headers, [example]);
}

/** Human-readable column guide, shown next to the upload control. */
export function describeTemplate(kind: ImportKind): {
  title: string;
  description: string;
  keyExplanation: string;
  columns: Array<{ header: string; required: boolean; description: string }>;
} {
  const template = IMPORT_TEMPLATES[kind];
  return {
    title: template.title,
    description: template.description,
    keyExplanation: template.keyExplanation,
    columns: template.columns.map((column) => ({
      header: column.header,
      required: column.required,
      description: column.description,
    })),
  };
}
