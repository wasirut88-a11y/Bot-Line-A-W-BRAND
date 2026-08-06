import { GoogleGenAI, Type } from '@google/genai';
import {
  DEFAULT_REPLY,
  GEMINI_TIMEOUT_MS,
  MAX_OUTPUT_TOKENS,
  MAX_REPLY_CHARS,
  MODEL,
  THINKING_LEVEL,
  requireEnv,
} from './config';
import { buildQuestion, buildSystemInstruction } from './prompt';
import { errorMessage, log } from './log';

export interface GeminiResult {
  /** Ready to send to LINE — either the model's answer or DEFAULT_REPLY. */
  text: string;
  /**
   * The FAQ row id the answer came from, or ''. The caller uses it to find an
   * image for the reply, and it makes the logs answer "which row did this come
   * from" instead of only "did we fall back".
   */
  sourceId: string;
  usedDefault: boolean;
  finishReason: string;
  latencyMs: number;
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
}

/**
 * Asking for the source row alongside the answer is the only reliable way to
 * know which row was used — the FAQ goes in as one CSV blob and prose coming
 * back cannot be traced to a line of it.
 */
const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    answer: {
      type: Type.STRING,
      description: 'คำตอบภาษาไทยที่ส่งให้ลูกค้าได้ทันที',
    },
    sourceId: {
      type: Type.STRING,
      description:
        'ค่า id ของแถวใน FAQ ที่ใช้ตอบ เช่น Q001 · ถ้าตอบด้วยข้อความสำรองหรือไม่ได้อ้างแถวใด ให้เป็นสตริงว่าง',
    },
  },
  required: ['answer', 'sourceId'],
};

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  // Lazily built so `next build` doesn't need GEMINI_API_KEY present.
  client ??= new GoogleGenAI({ apiKey: requireEnv('GEMINI_API_KEY') });
  return client;
}

export async function askGemini(question: string, faqCsv: string): Promise<GeminiResult> {
  const startedAt = Date.now();

  try {
    const response = await getClient().models.generateContent({
      model: MODEL,
      contents: buildQuestion(question),
      config: {
        systemInstruction: buildSystemInstruction(faqCsv),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        // Google advises against setting temperature / topP / topK on Gemini 3.x;
        // omitting them keeps the model's intended defaults.
        thinkingConfig: { thinkingLevel: THINKING_LEVEL },
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
        abortSignal: AbortSignal.timeout(GEMINI_TIMEOUT_MS),
      },
    });

    const latencyMs = Date.now() - startedAt;
    const usage = response.usageMetadata ?? {};
    const finishReason = response.candidates?.[0]?.finishReason ?? 'NONE';

    const telemetry = {
      latencyMs,
      finishReason: String(finishReason),
      promptTokenCount: usage.promptTokenCount ?? 0,
      candidatesTokenCount: usage.candidatesTokenCount ?? 0,
      thoughtsTokenCount: usage.thoughtsTokenCount ?? 0,
    };

    // Anything short of a clean stop means the text is untrustworthy: MAX_TOKENS
    // cuts mid-sentence, SAFETY and RECITATION return partial or empty content.
    if (finishReason !== 'STOP') {
      return { ...telemetry, text: DEFAULT_REPLY, sourceId: '', usedDefault: true };
    }

    const parsed = parseResponse(response.text);
    const answer = sanitize(parsed.answer);
    if (!answer) {
      return { ...telemetry, text: DEFAULT_REPLY, sourceId: '', usedDefault: true };
    }

    // A default reply carries no source, whichever route produced it.
    const usedDefault = answer === DEFAULT_REPLY;
    return {
      ...telemetry,
      text: answer,
      sourceId: usedDefault ? '' : parsed.sourceId,
      usedDefault,
    };
  } catch (error) {
    // No retry: the reply token expires long before a second attempt could land.
    log.error('gemini.failed', {
      error: errorMessage(error),
      latencyMs: Date.now() - startedAt,
    });
    return {
      text: DEFAULT_REPLY,
      sourceId: '',
      usedDefault: true,
      finishReason: 'ERROR',
      latencyMs: Date.now() - startedAt,
      promptTokenCount: 0,
      candidatesTokenCount: 0,
      thoughtsTokenCount: 0,
    };
  }
}

/**
 * The schema makes valid JSON overwhelmingly likely, but a customer-facing bot
 * should not fall over on the exception. A malformed body degrades to the
 * default reply rather than throwing.
 */
function parseResponse(raw: string | undefined): { answer: string; sourceId: string } {
  if (!raw) return { answer: '', sourceId: '' };
  try {
    const data = JSON.parse(raw) as { answer?: unknown; sourceId?: unknown };
    return {
      answer: typeof data.answer === 'string' ? data.answer : '',
      sourceId: typeof data.sourceId === 'string' ? data.sourceId.trim() : '',
    };
  } catch {
    log.warn('gemini.bad-json');
    return { answer: '', sourceId: '' };
  }
}

/**
 * The prompt forbids markdown, but a stray `**` still slips through often enough
 * that LINE would render the asterisks literally to the customer.
 */
export function sanitize(raw: string): string {
  let text = raw
    .replace(/```[a-z]*\n?/gi, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*>\s+/gm, '')
    // Collapse any run of blank lines; the format allows a single line break.
    .replace(/\n{2,}/g, '\n')
    .trim();

  if (text.length > MAX_REPLY_CHARS) {
    text = `${text.slice(0, MAX_REPLY_CHARS - 1).trimEnd()}…`;
  }
  return text;
}
