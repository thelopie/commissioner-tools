/**
 * Field validators for imported CSV values.
 *
 * Written specifically for spreadsheet input, which is messier than API input:
 * currency arrives as `$1,200.00`, dates as `8/14/2019`, booleans as `Y`. Each
 * validator either produces a normalized value or a message a commissioner can
 * act on — never a silent coercion, because a misread dues amount is a real
 * argument at a real draft.
 */

export interface FieldResult<T> {
  ok: boolean;
  value?: T;
  message?: string;
}

const ok = <T>(value: T): FieldResult<T> => ({ ok: true, value });
const fail = <T>(message: string): FieldResult<T> => ({ ok: false, message });

export function requiredText(raw: string, options: { max?: number } = {}): FieldResult<string> {
  const value = raw.trim();
  if (value.length === 0) return fail('is required');
  if (options.max && value.length > options.max) {
    return fail(`must be ${options.max} characters or fewer (got ${value.length})`);
  }
  return ok(value);
}

export function optionalText(
  raw: string,
  options: { max?: number } = {},
): FieldResult<string | undefined> {
  const value = raw.trim();
  if (value.length === 0) return ok(undefined);
  return requiredText(value, options) as FieldResult<string | undefined>;
}

/**
 * Parses a season year.
 *
 * Rejects a two-digit year outright rather than guessing a century: `19` could
 * mean 2019 or 1919, and a wrong guess silently files a season under the wrong
 * decade.
 */
export function seasonYear(raw: string): FieldResult<number> {
  const value = raw.trim();
  if (value.length === 0) return fail('is required');
  if (/^\d{2}$/.test(value)) {
    return fail(`"${value}" is ambiguous — write the full four-digit year`);
  }
  if (!/^\d{4}$/.test(value)) return fail(`"${value}" is not a four-digit year`);

  const year = Number(value);
  if (year < 1990 || year > 2100) return fail(`${year} is outside the supported range 1990–2100`);
  return ok(year);
}

export function weekNumber(raw: string): FieldResult<number> {
  const value = raw.trim();
  if (value.length === 0) return fail('is required');
  if (!/^\d{1,2}$/.test(value)) return fail(`"${value}" is not a week number`);

  const week = Number(value);
  if (week < 1 || week > 22) return fail(`week ${week} is outside the supported range 1–22`);
  return ok(week);
}

/**
 * Parses currency into integer cents.
 *
 * Accepts `$1,200.00`, `1200`, `1,200.5`, and `(50.00)` for a negative — the
 * accounting parenthesis form appears in exported spreadsheets. Integer cents,
 * never a float: `12.34` stored as a double reads back as 12.339999999999998 and
 * corrupts dues reconciliation.
 */
export function currencyCents(raw: string): FieldResult<number> {
  let value = raw.trim();
  if (value.length === 0) return fail('is required');

  let negative = false;
  if (/^\(.*\)$/.test(value)) {
    negative = true;
    value = value.slice(1, -1).trim();
  }
  if (value.startsWith('-')) {
    negative = true;
    value = value.slice(1).trim();
  }

  value = value.replace(/^\$/, '').replace(/,/g, '').trim();

  if (!/^\d+(\.\d{1,2})?$/.test(value)) {
    if (/^\d+\.\d{3,}$/.test(value)) {
      return fail(`"${raw.trim()}" has more than two decimal places`);
    }
    return fail(`"${raw.trim()}" is not a currency amount`);
  }

  const [whole, fraction = ''] = value.split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));

  return ok(negative ? -cents : cents);
}

/**
 * Parses a date to `YYYY-MM-DD`.
 *
 * Accepts ISO and US `M/D/YYYY`, and rejects ambiguous two-digit years and
 * impossible dates. Deliberately does NOT accept `D/M/YYYY`: `3/4/2019` cannot be
 * disambiguated from `4/3/2019`, so accepting both would mean silently choosing
 * one interpretation of a dues deadline.
 */
export function isoDate(raw: string): FieldResult<string> {
  const value = raw.trim();
  if (value.length === 0) return fail('is required');

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value);
  if (iso) return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), value);

  const us = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(value);
  if (us) return buildDate(Number(us[3]), Number(us[1]), Number(us[2]), value);

  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2}$/.test(value)) {
    return fail(`"${value}" has a two-digit year — write the full year (M/D/YYYY or YYYY-MM-DD)`);
  }

  return fail(`"${value}" is not a date the importer recognizes (use YYYY-MM-DD or M/D/YYYY)`);
}

function buildDate(
  year: number,
  month: number,
  day: number,
  original: string,
): FieldResult<string> {
  if (month < 1 || month > 12) return fail(`"${original}" has month ${month}`);
  if (day < 1 || day > 31) return fail(`"${original}" has day ${day}`);

  const date = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check catches February 30 and similar, which Date would roll over.
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return fail(`"${original}" is not a real date`);
  }

  const pad = (n: number): string => String(n).padStart(2, '0');
  return ok(`${year}-${pad(month)}-${pad(day)}`);
}

const TRUE_VALUES = new Set(['true', 'yes', 'y', '1', 'paid', 'x', '✓']);
const FALSE_VALUES = new Set(['false', 'no', 'n', '0', 'unpaid', '']);

/** Parses the many ways a spreadsheet says yes. */
export function boolean(raw: string, options: { default?: boolean } = {}): FieldResult<boolean> {
  const value = raw.trim().toLowerCase();

  if (value.length === 0 && options.default !== undefined) return ok(options.default);
  if (TRUE_VALUES.has(value)) return ok(true);
  if (FALSE_VALUES.has(value)) return ok(false);

  return fail(`"${raw.trim()}" is not a yes/no value`);
}

/** Parses a plain decimal, e.g. a challenge-winning score. */
export function decimal(raw: string): FieldResult<number> {
  const value = raw.trim().replace(/,/g, '');
  if (value.length === 0) return fail('is required');
  if (!/^-?\d+(\.\d+)?$/.test(value)) return fail(`"${raw.trim()}" is not a number`);

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fail(`"${raw.trim()}" is not a finite number`);
  return ok(parsed);
}

export function integer(
  raw: string,
  options: { min?: number; max?: number } = {},
): FieldResult<number> {
  const value = raw.trim().replace(/,/g, '');
  if (value.length === 0) return fail('is required');
  if (!/^-?\d+$/.test(value)) return fail(`"${raw.trim()}" is not a whole number`);

  const parsed = Number(value);
  if (options.min !== undefined && parsed < options.min)
    return fail(`must be at least ${options.min}`);
  if (options.max !== undefined && parsed > options.max)
    return fail(`must be at most ${options.max}`);
  return ok(parsed);
}

/** Validates against a fixed set, listing the valid options on failure. */
export function oneOf<T extends string>(raw: string, allowed: readonly T[]): FieldResult<T> {
  const value = raw
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  const match = allowed.find((option) => option.toLowerCase() === value);
  if (match) return ok(match);
  return fail(`"${raw.trim()}" is not one of: ${allowed.join(', ')}`);
}

export function email(raw: string): FieldResult<string | undefined> {
  const value = raw.trim();
  if (value.length === 0) return ok(undefined);
  // Deliberately permissive: the goal is catching typos, not enforcing RFC 5322.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return fail(`"${value}" is not an email address`);
  return ok(value.toLowerCase());
}
