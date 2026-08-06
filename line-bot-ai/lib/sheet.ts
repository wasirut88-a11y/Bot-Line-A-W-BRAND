import { ACTIVE_STATUS, SHEET_CACHE_TTL_MS, SHEET_TIMEOUT_MS, requireEnv } from './config';

export interface FaqRow {
  id: string;
  category: string;
  question: string;
  keywords: string;
  answer: string;
  /**
   * Optional. A filename served from public/products/, or a full https URL.
   * When present, the reply carries this image alongside the text.
   */
  image: string;
}

export interface FaqResult {
  /** CSV of active rows, header included. Ready to drop into the prompt. */
  csv: string;
  /** The same active rows, parsed — used by the Flex card builders. */
  rows: FaqRow[];
  /** True when served from cache without a network round trip. */
  cacheHit: boolean;
  /** True when the network failed and a previously cached copy was served. */
  stale: boolean;
}

/**
 * In-memory and therefore per serverless instance — Vercel may run several, and
 * each keeps its own copy. At low traffic that means the sheet is fetched more
 * often than the 60s TTL suggests, which is fine at this scale.
 */
let cache: { csv: string; rows: FaqRow[]; fetchedAt: number } | null = null;

export async function getFaqCsv(): Promise<FaqResult> {
  if (cache && Date.now() - cache.fetchedAt < SHEET_CACHE_TTL_MS) {
    return { csv: cache.csv, rows: cache.rows, cacheHit: true, stale: false };
  }

  try {
    const { csv, rows } = await fetchActiveRows();
    cache = { csv, rows, fetchedAt: Date.now() };
    return { csv, rows, cacheHit: false, stale: false };
  } catch (error) {
    // A stale answer beats no answer, so fall back to whatever is still held.
    if (cache) {
      console.warn(
        JSON.stringify({ tag: 'line-bot', event: 'sheet-stale', error: String(error) }),
      );
      return { csv: cache.csv, rows: cache.rows, cacheHit: false, stale: true };
    }
    throw error;
  }
}

async function fetchActiveRows(): Promise<{ csv: string; rows: FaqRow[] }> {
  const response = await fetch(requireEnv('SHEET_CSV_URL'), {
    cache: 'no-store',
    signal: AbortSignal.timeout(SHEET_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Sheet fetch failed: HTTP ${response.status}`);
  }

  const rows = parseCsv(await response.text());
  if (rows.length < 2) {
    throw new Error('Sheet has no data rows');
  }

  const header = rows[0];
  const statusIndex = header.findIndex((column) => column.trim().toLowerCase() === 'status');
  if (statusIndex === -1) {
    throw new Error('Sheet is missing a "status" column');
  }

  const active = rows
    .slice(1)
    .filter((row) => row[statusIndex]?.trim().toLowerCase() === ACTIVE_STATUS);
  if (active.length === 0) {
    throw new Error('Sheet has no active rows');
  }

  const index = (name: string) =>
    header.findIndex((column) => column.trim().toLowerCase() === name);
  const columns = {
    id: index('id'),
    category: index('category'),
    question: index('question'),
    keywords: index('keywords'),
    answer: index('answer'),
    image: index('image'),
  };
  const cell = (row: string[], at: number) => (at === -1 ? '' : (row[at] ?? '').trim());

  // The image column is deliberately kept out of the prompt CSV: the model
  // never needs a filename to write an answer, and every column costs tokens on
  // every request. The route looks it up from `rows` after the fact.
  const promptColumns = header
    .map((_, i) => i)
    .filter((i) => i !== columns.image || columns.image === -1);
  const trim = (row: string[]) => promptColumns.map((i) => row[i] ?? '');

  return {
    csv: [header, ...active].map((row) => serializeRow(trim(row))).join('\n'),
    rows: active.map((row) => ({
      id: cell(row, columns.id),
      category: cell(row, columns.category),
      question: cell(row, columns.question),
      keywords: cell(row, columns.keywords),
      answer: cell(row, columns.answer),
      image: cell(row, columns.image),
    })),
  };
}

/**
 * RFC 4180 parser. A hand-rolled `split(',')` would corrupt the sheet the first
 * time an answer contains a comma, which Thai product answers routinely do.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  // Normalize line endings so CRLF from Google Sheets doesn't leak into fields.
  const input = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < input.length; i++) {
    const char = input[i];

    if (quoted) {
      if (char !== '"') {
        field += char;
      } else if (input[i + 1] === '"') {
        field += '"'; // Escaped quote inside a quoted field.
        i++;
      } else {
        quoted = false;
      }
      continue;
    }

    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }

  // Flush the final field unless the file ended with a clean newline.
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

function serializeRow(row: string[]): string {
  return row
    .map((cell) => {
      // Collapse newlines: the prompt treats one FAQ row as one line.
      const flat = cell.replace(/\n/g, ' ').trim();
      return /[",]/.test(flat) ? `"${flat.replace(/"/g, '""')}"` : flat;
    })
    .join(',');
}

/**
 * Looks up the row an answer came from.
 *
 * Returns null when the id is missing OR matches more than one row. Duplicate
 * ids happen easily — a person copying a block of rows in the sheet — and the
 * consequence here is specific: an ambiguous id would attach the first matching
 * row's photo, so a question about toothpaste could ship a picture of the eye
 * supplement. No photo is a far smaller failure than the wrong product.
 */
export function findRowById(rows: FaqRow[], id: string): FaqRow | null {
  if (!id) return null;
  const matches = rows.filter((row) => row.id === id);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.warn(
      JSON.stringify({ tag: 'line-bot', level: 'warn', event: 'sheet.duplicate-id', id }),
    );
  }
  return null;
}

/** Test seam — lets the local harness exercise the request path without a sheet. */
export function __resetCache(): void {
  cache = null;
}
