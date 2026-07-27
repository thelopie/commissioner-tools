import { describe, expect, it } from 'vitest';
import {
  analyzeImport,
  assertCanRollback,
  buildExternalKey,
  canRollback,
  describeTemplate,
  IMPORT_TEMPLATES,
  parseCsv,
  renderTemplate,
  suggestMappings,
  toCsv,
  validateHeaders,
  validators as v,
  type ExistingRecord,
} from './index.js';
import type { ImportKind } from '@dinkel/shared';

describe('parseCsv', () => {
  it('parses headers and rows', () => {
    const parsed = parseCsv('season,manager\n2019,Sample Manager\n2020,Other Manager\n');

    expect(parsed.headers).toEqual(['season', 'manager']);
    expect(parsed.rows).toEqual([
      { season: '2019', manager: 'Sample Manager' },
      { season: '2020', manager: 'Other Manager' },
    ]);
  });

  it('strips the BOM Excel writes', () => {
    const parsed = parseCsv('﻿season,manager\n2019,A\n');
    expect(parsed.headers).toEqual(['season', 'manager']);
  });

  it('handles CRLF, LF, and mixed line endings', () => {
    const parsed = parseCsv('a,b\r\n1,2\n3,4\r\n');
    expect(parsed.rows).toEqual([
      { a: '1', b: '2' },
      { a: '3', b: '4' },
    ]);
  });

  it('keeps commas inside quoted values', () => {
    // A league rule reading "no vetoes, ever" must not become two columns.
    const parsed = parseCsv('title,rule\nTrades,"No vetoes, ever"\n');
    expect(parsed.rows[0]?.rule).toBe('No vetoes, ever');
  });

  it('handles escaped quotes and newlines inside a quoted value', () => {
    const parsed = parseCsv('title,rule\nQuote,"He said ""no"".\nThen left."\n');
    expect(parsed.rows[0]?.rule).toBe('He said "no".\nThen left.');
  });

  it('skips blank spacer rows, which are normal in hand-kept sheets', () => {
    const parsed = parseCsv('a,b\n1,2\n\n,\n3,4\n');
    expect(parsed.rows).toHaveLength(2);
  });

  it('fills missing trailing columns rather than failing the row', () => {
    const parsed = parseCsv('a,b,c\n1,2\n');
    expect(parsed.rows[0]).toEqual({ a: '1', b: '2', c: '' });
  });

  it('reports the source line for each row, so errors point at the right place', () => {
    const parsed = parseCsv('a\n1\n2\n3\n');
    expect(parsed.rowLineNumbers).toEqual([2, 3, 4]);
  });

  it('accounts for newlines inside quotes when numbering lines', () => {
    const parsed = parseCsv('a,b\n1,"two\nlines"\n3,4\n');
    expect(parsed.rowLineNumbers).toEqual([2, 4]);
  });

  it('rejects an empty file', () => {
    expect(() => parseCsv('   \n')).toThrow(/empty/);
  });

  it('rejects duplicate or blank headers', () => {
    expect(() => parseCsv('a,a\n1,2\n')).toThrow(/more than once/);
    expect(() => parseCsv('a,,c\n1,2,3\n')).toThrow(/no name/);
  });

  it('rejects an unclosed quote instead of silently mangling data', () => {
    expect(() => parseCsv('a,b\n1,"unterminated\n')).toThrow(/unclosed quoted value/);
  });

  it('round-trips through toCsv', () => {
    const csv = toCsv(['a', 'b'], [{ a: 'plain', b: 'has, comma' }]);
    expect(parseCsv(csv).rows[0]).toEqual({ a: 'plain', b: 'has, comma' });
  });
});

describe('currency validation', () => {
  it('parses common spreadsheet currency formats into integer cents', () => {
    // Integer cents, never a float: 12.34 as a double reads back as
    // 12.339999999999998 and corrupts dues reconciliation.
    expect(v.currencyCents('$1,200.00').value).toBe(120_000);
    expect(v.currencyCents('50').value).toBe(5000);
    expect(v.currencyCents('12.34').value).toBe(1234);
    expect(v.currencyCents('12.3').value).toBe(1230);
  });

  it('parses the accounting parenthesis form as negative', () => {
    expect(v.currencyCents('(50.00)').value).toBe(-5000);
    expect(v.currencyCents('-25').value).toBe(-2500);
  });

  it('rejects more than two decimal places rather than rounding silently', () => {
    const result = v.currencyCents('12.345');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('two decimal places');
  });

  it('rejects text', () => {
    expect(v.currencyCents('fifty dollars').ok).toBe(false);
    expect(v.currencyCents('').ok).toBe(false);
  });
});

describe('date validation', () => {
  it('accepts ISO and US formats', () => {
    expect(v.isoDate('2019-08-25').value).toBe('2019-08-25');
    expect(v.isoDate('8/25/2019').value).toBe('2019-08-25');
    expect(v.isoDate('8-5-2019').value).toBe('2019-08-05');
  });

  it('rejects a two-digit year rather than guessing a century', () => {
    const result = v.isoDate('8/25/19');
    expect(result.ok).toBe(false);
    expect(result.message).toContain('two-digit year');
  });

  it('rejects impossible dates that Date would roll over', () => {
    // Date(2019, 1, 30) silently becomes March 2.
    expect(v.isoDate('2019-02-30').ok).toBe(false);
    expect(v.isoDate('13/1/2019').ok).toBe(false);
  });
});

describe('other validators', () => {
  it('rejects an ambiguous two-digit season year', () => {
    expect(v.seasonYear('19').message).toContain('ambiguous');
    expect(v.seasonYear('2019').value).toBe(2019);
  });

  it('bounds week numbers', () => {
    expect(v.weekNumber('3').value).toBe(3);
    expect(v.weekNumber('23').ok).toBe(false);
    expect(v.weekNumber('0').ok).toBe(false);
  });

  it('reads the many ways a spreadsheet says yes', () => {
    for (const yes of ['yes', 'Y', 'true', '1', 'PAID', 'x', '✓']) {
      expect(v.boolean(yes).value, yes).toBe(true);
    }
    for (const no of ['no', 'N', 'false', '0', 'unpaid']) {
      expect(v.boolean(no).value, no).toBe(false);
    }
    expect(v.boolean('maybe').ok).toBe(false);
  });

  it('lists valid options when a value is not allowed', () => {
    const result = v.oneOf('venmoo', ['cash', 'venmo', 'zelle']);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('cash, venmo, zelle');
  });

  it('normalizes spacing and case for enumerated values', () => {
    expect(v.oneOf('Draft Pending', ['planned', 'draft_pending']).value).toBe('draft_pending');
  });

  it('preserves negative decimals, which fantasy scoring produces', () => {
    expect(v.decimal('-2.5').value).toBe(-2.5);
  });
});

describe('templates', () => {
  const kinds: ImportKind[] = [
    'seasons',
    'managers',
    'league_rules',
    'prize_rules',
    'weekly_challenge_definitions',
    'historical_challenge_winners',
    'dues',
    'payouts',
    'draft_history',
  ];

  it('provides a template for all nine import kinds', () => {
    for (const kind of kinds) {
      expect(IMPORT_TEMPLATES[kind], kind).toBeDefined();
    }
  });

  it('renders a downloadable template with an example row', () => {
    for (const kind of kinds) {
      const csv = renderTemplate(kind);
      const parsed = parseCsv(csv);
      // A header-only template leaves a commissioner guessing at date and
      // currency formats, which produces row errors instead of a clear failure.
      expect(parsed.rows, kind).toHaveLength(1);
      expect(parsed.headers.length, kind).toBeGreaterThan(1);
    }
  });

  it('renders example rows that pass their own validators', () => {
    for (const kind of kinds) {
      const template = IMPORT_TEMPLATES[kind];
      for (const column of template.columns) {
        const result = column.validate(column.example);
        expect(result.ok, `${kind}.${column.header} example "${column.example}"`).toBe(true);
      }
    }
  });

  it('defines an external key for every kind, so re-imports are idempotent', () => {
    for (const kind of kinds) {
      expect(IMPORT_TEMPLATES[kind].externalKeyColumns.length, kind).toBeGreaterThan(0);
    }
  });

  it('describes columns for the upload screen', () => {
    const described = describeTemplate('dues');
    expect(described.title).toBe('Dues');
    expect(
      described.columns.some((column) => column.header === 'amount_owed' && column.required),
    ).toBe(true);
  });

  it('uses only placeholder data in examples, since this repository is public', () => {
    for (const kind of kinds) {
      const csv = renderTemplate(kind);
      if (csv.includes('@')) expect(csv).toContain('@example.com');
      if (/manager/i.test(csv)) expect(csv).toMatch(/Sample|example/i);
    }
  });
});

describe('mapping', () => {
  it('suggests a mapping from header names, including loose matches', () => {
    const suggested = suggestMappings('dues', ['Season', 'manager', 'Amount Owed', 'notes']);

    expect(suggested).toEqual([
      { sourceHeader: 'Season', targetField: 'seasonYear' },
      { sourceHeader: 'manager', targetField: 'managerName' },
      { sourceHeader: 'Amount Owed', targetField: 'amountOwed' },
      // Unrecognized columns are left unmapped for the commissioner to decide.
      { sourceHeader: 'notes', targetField: null },
    ]);
  });

  it('reports a required column that is not mapped', () => {
    const problems = validateHeaders(
      'dues',
      ['season'],
      [{ sourceHeader: 'season', targetField: 'seasonYear' }],
    );

    expect(problems.some((problem) => problem.includes('manager'))).toBe(true);
    expect(problems.some((problem) => problem.includes('amount_owed'))).toBe(true);
  });

  it('reports a column with no mapping decision', () => {
    const problems = validateHeaders(
      'dues',
      ['season', 'mystery'],
      [{ sourceHeader: 'season', targetField: 'seasonYear' }],
    );
    expect(problems.some((problem) => problem.includes('mystery'))).toBe(true);
  });

  it('rejects two columns mapped to the same field', () => {
    const problems = validateHeaders(
      'dues',
      ['a', 'b'],
      [
        { sourceHeader: 'a', targetField: 'amountOwed' },
        { sourceHeader: 'b', targetField: 'amountOwed' },
      ],
    );
    // Picking one silently would discard data the commissioner meant to import.
    expect(problems.some((problem) => problem.includes('mapped to "amountOwed"'))).toBe(true);
  });
});

describe('analyzeImport', () => {
  const duesMappings = [
    { sourceHeader: 'season', targetField: 'seasonYear' },
    { sourceHeader: 'manager', targetField: 'managerName' },
    { sourceHeader: 'amount_owed', targetField: 'amountOwed' },
    { sourceHeader: 'amount_paid', targetField: 'amountPaid' },
  ];

  const csv = (rows: string): string => `season,manager,amount_owed,amount_paid\n${rows}`;

  const analyze = (
    rows: string,
    existing: Map<string, ExistingRecord> = new Map(),
    conflictResolution:
      'skip_conflicts' | 'overwrite_conflicts' | 'fail_on_conflict' = 'fail_on_conflict',
  ) =>
    analyzeImport({
      kind: 'dues',
      csvText: csv(rows),
      mappings: duesMappings,
      existing,
      conflictResolution,
    });

  it('plans creates for new rows', () => {
    const analysis = analyze('2019,Sample Manager,$50.00,$50.00\n2019,Other Manager,$50.00,\n');

    expect(analysis.summary.wouldCreate).toBe(2);
    expect(analysis.summary.errorRows).toBe(0);
    expect(analysis.blockingProblems).toEqual([]);
    expect(analysis.rows[0]?.values).toMatchObject({
      seasonYear: 2019,
      managerName: 'Sample Manager',
      amountOwed: 5000,
      amountPaid: 5000,
    });
  });

  it('scopes an error to its row, so one bad row never fails the file', () => {
    const analysis = analyze('2019,Sample Manager,$50.00,\nnot-a-year,Other,$50.00,\n');

    expect(analysis.summary.errorRows).toBe(1);
    expect(analysis.summary.wouldCreate).toBe(1);
    expect(analysis.rows[1]?.outcome).toBe('error');
    expect(analysis.rows[1]?.errors[0]?.field).toBe('season');
  });

  it('points at the right source line in an error', () => {
    const analysis = analyze('2019,A,$50.00,\nbad,B,$50.00,\n');
    expect(analysis.rows[1]?.sourceLine).toBe(3);
  });

  it('reports a required field left blank as a row error', () => {
    const analysis = analyze('2019,,$50.00,\n');
    expect(analysis.rows[0]?.outcome).toBe('error');
    expect(analysis.rows[0]?.errors.some((error) => error.field === 'manager')).toBe(true);
  });

  it('skips a row already imported with identical values, making re-imports idempotent', () => {
    const existing = new Map<string, ExistingRecord>([
      [
        '2019|sample manager',
        {
          externalKey: '2019|sample manager',
          values: { seasonYear: '2019', managerName: 'Sample Manager', amountOwed: '5000' },
        },
      ],
    ]);

    const analysis = analyze('2019,Sample Manager,$50.00,\n', existing);

    expect(analysis.rows[0]?.outcome).toBe('skipped_duplicate');
    expect(analysis.summary.duplicateRows).toBe(1);
    expect(analysis.summary.wouldCreate).toBe(0);
  });

  it('matches an external key regardless of name capitalization', () => {
    // A decade of inconsistent typing must not create a second manager.
    const existing = new Map<string, ExistingRecord>([
      [
        '2019|sample manager',
        {
          externalKey: '2019|sample manager',
          values: { seasonYear: '2019', managerName: 'SAMPLE MANAGER' },
        },
      ],
    ]);

    const analysis = analyze('2019,sample manager,$50.00,\n', existing, 'overwrite_conflicts');
    expect(analysis.rows[0]?.externalKey).toBe('2019|sample manager');
    expect(analysis.rows[0]?.outcome).not.toBe('would_create');
  });

  it('detects a conflict and refuses to commit without a decision', () => {
    const existing = new Map<string, ExistingRecord>([
      [
        '2019|sample manager',
        {
          externalKey: '2019|sample manager',
          values: { seasonYear: '2019', managerName: 'Sample Manager', amountOwed: '5000' },
        },
      ],
    ]);

    const analysis = analyze('2019,Sample Manager,$75.00,\n', existing);

    expect(analysis.summary.conflictRows).toBe(1);
    expect(analysis.rows[0]?.conflicts[0]).toEqual({
      field: 'amount_owed',
      existingValue: '5000',
      incomingValue: '7500',
    });
    // No silent overwrite: committing is blocked until the choice is explicit.
    expect(analysis.blockingProblems[0]).toContain('overwrite or skip');
  });

  it('plans an update once overwrite is chosen explicitly', () => {
    const existing = new Map<string, ExistingRecord>([
      [
        '2019|sample manager',
        { externalKey: '2019|sample manager', values: { amountOwed: '5000' } },
      ],
    ]);

    const analysis = analyze('2019,Sample Manager,$75.00,\n', existing, 'overwrite_conflicts');

    expect(analysis.rows[0]?.outcome).toBe('would_update');
    expect(analysis.summary.wouldUpdate).toBe(1);
    expect(analysis.blockingProblems).toEqual([]);
  });

  it('skips conflicts when skipping is chosen', () => {
    const existing = new Map<string, ExistingRecord>([
      [
        '2019|sample manager',
        { externalKey: '2019|sample manager', values: { amountOwed: '5000' } },
      ],
    ]);

    const analysis = analyze('2019,Sample Manager,$75.00,\n', existing, 'skip_conflicts');

    expect(analysis.rows[0]?.outcome).toBe('skipped_conflict');
    expect(analysis.blockingProblems).toEqual([]);
  });

  it('rejects a file containing the same key twice', () => {
    // The second row would overwrite the first inside a single import.
    const analysis = analyze('2019,Sample Manager,$50.00,\n2019,Sample Manager,$75.00,\n');

    expect(analysis.rows[1]?.outcome).toBe('error');
    expect(analysis.rows[1]?.errors[0]?.message).toContain('duplicates row 1');
  });

  it('surfaces header problems as blocking, before any row work', () => {
    const analysis = analyzeImport({
      kind: 'dues',
      csvText: 'season,manager\n2019,A\n',
      mappings: [
        { sourceHeader: 'season', targetField: 'seasonYear' },
        { sourceHeader: 'manager', targetField: 'managerName' },
      ],
      existing: new Map(),
      conflictResolution: 'fail_on_conflict',
    });

    expect(analysis.blockingProblems.some((problem) => problem.includes('amount_owed'))).toBe(true);
  });

  it('ignores an unmapped column instead of guessing where it belongs', () => {
    const analysis = analyzeImport({
      kind: 'dues',
      csvText: 'season,manager,amount_owed,mystery\n2019,A,$50.00,whatever\n',
      mappings: [...duesMappings.slice(0, 3), { sourceHeader: 'mystery', targetField: null }],
      existing: new Map(),
      conflictResolution: 'fail_on_conflict',
    });

    expect(analysis.blockingProblems).toEqual([]);
    expect(analysis.rows[0]?.values).not.toHaveProperty('mystery');
  });
});

describe('buildExternalKey', () => {
  it('is stable, lowercased, and separator-joined', () => {
    expect(
      buildExternalKey(['seasonYear', 'managerName'], {
        seasonYear: 2019,
        managerName: 'Sample Manager',
      }),
    ).toBe('2019|sample manager');
  });

  it('produces the same key for differently-typed equivalents', () => {
    const a = buildExternalKey(['seasonYear'], { seasonYear: 2019 });
    const b = buildExternalKey(['seasonYear'], { seasonYear: '2019' });
    expect(a).toBe(b);
  });
});

describe('rollback', () => {
  const committed = { status: 'committed', committedAt: '2026-07-26T00:00:00' };

  it('allows rollback when nothing depends on the imported rows', () => {
    const decision = canRollback(committed, [{ externalKey: 'k', values: {} }]);
    expect(decision.allowed).toBe(true);
    expect(() => assertCanRollback(committed, [{ externalKey: 'k', values: {} }])).not.toThrow();
  });

  it('refuses rollback when a later record depends on an imported row', () => {
    // Deleting a challenge result out from under a payout leaves the ledger
    // pointing at nothing, which is worse than an unwanted import.
    const records = [{ externalKey: 'k', values: {}, hasDependents: true }];

    const decision = canRollback(committed, records);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('depending on them');

    expect(() => assertCanRollback(committed, records)).toThrow(
      expect.objectContaining({ code: 'import_rollback_blocked' }),
    );
  });

  it('refuses rollback for a batch that was never committed', () => {
    for (const status of ['uploaded', 'dry_run_complete', 'failed', 'rolled_back']) {
      expect(canRollback({ status }, []).allowed).toBe(false);
    }
  });
});
