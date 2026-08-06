/**
 * One JSON object per line, which is what Vercel's log viewer can filter on.
 *
 * Everything the bot emits carries `tag: 'line-bot'` so a single filter pulls up
 * the whole conversation flow and nothing else.
 */

type LogLevel = 'info' | 'warn' | 'error';

export interface LogContext {
  [key: string]: string | number | boolean | undefined;
}

function emit(level: LogLevel, event: string, ctx?: LogContext): void {
  const line = JSON.stringify({ tag: 'line-bot', level, event, ...ctx });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, ctx?: LogContext) => emit('info', event, ctx),
  warn: (event: string, ctx?: LogContext) => emit('warn', event, ctx),
  error: (event: string, ctx?: LogContext) => emit('error', event, ctx),
};

/**
 * User IDs are PII. Eight characters is enough to correlate a conversation
 * within a log window without storing anything identifying.
 */
export function shortId(id: string | undefined): string {
  return (id ?? 'unknown').slice(0, 8);
}

/** Normalizes a thrown value into something safe to log. */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
