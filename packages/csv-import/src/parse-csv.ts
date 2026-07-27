import { AppError } from '@dinkel/shared';

/**
 * CSV parsing.
 *
 * Written rather than pulled from a dependency because the requirements are
 * narrow and specific: RFC 4180 quoting, UTF-8 with a possible BOM (Excel writes
 * one), and mixed line endings from whatever tool the commissioner used. A
 * general-purpose parser would bring configuration surface this does not need.
 *
 * Quoted fields containing commas, newlines, and escaped quotes are all handled —
 * a league rule that reads `Trades: no vetoes, ever` must not become two columns.
 */

export interface ParsedCsv {
  headers: string[];
  /** One entry per data row, keyed by header. Missing trailing columns are ''. */
  rows: Array<Record<string, string>>;
  /** 1-based source line for each row, so errors point at the right place. */
  rowLineNumbers: number[];
}

const BOM = '﻿';

/**
 * Parses CSV text.
 *
 * @throws {AppError} `validation_failed` on an empty file, a header row with
 *   duplicate or blank names, or unterminated quoting — all of which would
 *   otherwise produce silently wrong data.
 */
export function parseCsv(text: string): ParsedCsv {
  const content = text.startsWith(BOM) ? text.slice(BOM.length) : text;

  if (content.trim().length === 0) {
    throw new AppError('validation_failed', {
      publicMessage: 'That file is empty.',
    });
  }

  const records = tokenize(content);
  const headerRecord = records[0];

  if (!headerRecord) {
    throw new AppError('validation_failed', { publicMessage: 'That file has no header row.' });
  }

  const headers = headerRecord.fields.map((field) => field.trim());

  const blankIndex = headers.findIndex((header) => header.length === 0);
  if (blankIndex !== -1) {
    throw new AppError('validation_failed', {
      publicMessage: `Column ${blankIndex + 1} in the header row has no name. Name every column.`,
    });
  }

  const duplicate = findDuplicate(headers);
  if (duplicate) {
    throw new AppError('validation_failed', {
      publicMessage: `The header "${duplicate}" appears more than once. Column names must be unique.`,
    });
  }

  const rows: Array<Record<string, string>> = [];
  const rowLineNumbers: number[] = [];

  for (const record of records.slice(1)) {
    // Skip rows that are entirely blank — trailing newlines and spacer rows are
    // normal in hand-maintained spreadsheets, not errors.
    if (record.fields.every((field) => field.trim().length === 0)) continue;

    const row: Record<string, string> = {};
    headers.forEach((header, index) => {
      row[header] = (record.fields[index] ?? '').trim();
    });

    rows.push(row);
    rowLineNumbers.push(record.line);
  }

  return { headers, rows, rowLineNumbers };
}

interface Record_ {
  fields: string[];
  line: number;
}

function tokenize(content: string): Record_[] {
  const records: Record_[] = [];
  let fields: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;

  const endField = (): void => {
    fields.push(field);
    field = '';
  };

  const endRecord = (): void => {
    endField();
    records.push({ fields, line: recordStartLine });
    fields = [];
  };

  for (let i = 0; i < content.length; i += 1) {
    const char = content[i]!;

    if (inQuotes) {
      if (char === '"') {
        if (content[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        if (char === '\n') line += 1;
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0) {
      inQuotes = true;
      continue;
    }

    if (char === ',') {
      endField();
      continue;
    }

    // A record ends at CR, LF, or CRLF. Mixed endings occur when a file has been
    // through more than one tool, which is normal for a long-lived spreadsheet.
    if (char === '\r' || char === '\n') {
      if (char === '\r' && content[i + 1] === '\n') i += 1;
      endRecord();
      line += 1;
      recordStartLine = line;
      continue;
    }

    field += char;
  }

  if (inQuotes) {
    throw new AppError('validation_failed', {
      publicMessage:
        'That file has an unclosed quoted value. Check for a stray double-quote character.',
    });
  }

  // Trailing content with no final newline is still a record.
  if (field.length > 0 || fields.length > 0) {
    endField();
    records.push({ fields, line: recordStartLine });
  }

  return records;
}

function findDuplicate(values: readonly string[]): string | null {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = value.toLowerCase();
    if (seen.has(normalized)) return value;
    seen.add(normalized);
  }
  return null;
}

/** Serializes rows back to CSV, for template downloads and data exports. */
export function toCsv(
  headers: readonly string[],
  rows: ReadonlyArray<Record<string, string>>,
): string {
  const escape = (value: string): string =>
    /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;

  const lines = [headers.map(escape).join(',')];
  for (const row of rows) {
    lines.push(headers.map((header) => escape(row[header] ?? '')).join(','));
  }
  // Trailing newline: POSIX tools and Excel both prefer it.
  return `${lines.join('\r\n')}\r\n`;
}
