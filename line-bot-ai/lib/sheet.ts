import { ACTIVE_STATUS, SHEET_CACHE_TTL_MS, SHEET_TIMEOUT_MS, requireEnv } from './config';

export interface FaqResult {
  /** CSV of active rows, header included. Ready to drop into the prompt. */
  csv: string;
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
let cache: { csv: string; fetchedAt: number } | null = null;

export async function getFaqCsv(): Promise<FaqResult> {
  if (cache && Date.now() - cache.fetchedAt < SHEET_CACHE_TTL_MS) {
    return { csv: cache.csv, cacheHit: true, stale: false };
  }

  try {
    const csv = await fetchActiveRows();
    cache = { csv, fetchedAt: Date.now() };
    return { csv, cacheHit: false, stale: false };
  } catch (error) {
    // A stale answer beats no answer, so fall back to whatever is still held.
    if (cache) {
      console.warn(
        JSON.stringify({ tag: 'line-bot', event: 'sheet-stale', error: String(error) }),
      );
      return { csv: cache.csv, cacheHit: false, stale: true };
    }
    throw error;
  }
}

async function fetchActiveRows(): Promise<string> {
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

  return [header, ...active].map(serializeRow).join('\n');
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

/** Test seam — lets the local harness exercise the request path without a sheet. */
export function __resetCache(): void {
  cache = null;
}
