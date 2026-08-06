import { ThinkingLevel } from '@google/genai';

/**
 * Every tunable the bot has. The time budget below is the reason most of these
 * exist — LINE invalidates a replyToken if the whole request runs long, so each
 * stage gets a hard ceiling rather than an open-ended await.
 *
 *   verify + parse   < 50ms
 *   fetch sheet      <= 5s   (only on cache miss)
 *   Gemini           <= 8s
 *   LINE reply       <= 2s
 *   ------------------------
 *   total            ~10s, inside Vercel's 30s maxDuration
 */

/** Shown whenever the bot cannot answer from the FAQ, for any reason. */
export const DEFAULT_REPLY = 'รอสักครู่นะคะ เดี๋ยวแอดมินตัวจริงมาตอบให้ค่ะ 🙏';

export const MODEL = 'gemini-3.5-flash';

/**
 * Gemini 3.x counts thinking tokens against the output budget, so this is not
 * "answer length" — a 200-token cap would truncate mid-sentence after thinking.
 */
export const MAX_OUTPUT_TOKENS = 1024;

/**
 * FAQ lookup needs recall, not reasoning, and the time budget is tight. The
 * SDK default is MEDIUM; drop to MINIMAL if thoughtsTokenCount runs above ~700.
 */
export const THINKING_LEVEL = ThinkingLevel.LOW;

export const GEMINI_TIMEOUT_MS = 8_000;
export const SHEET_TIMEOUT_MS = 5_000;
export const SHEET_CACHE_TTL_MS = 60_000;

/** Longest customer message forwarded to Gemini; anything past this is cut. */
export const MAX_QUESTION_CHARS = 500;

/** Longest reply sent to LINE, after sanitizing. */
export const MAX_REPLY_CHARS = 500;

/** Only rows with this status reach the prompt. */
export const ACTIVE_STATUS = 'active';

/**
 * Read at call time rather than module load: Next.js evaluates route modules
 * during `next build`, where these are legitimately absent.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}
