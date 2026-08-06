import { GoogleGenAI } from '@google/genai';
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

export interface GeminiResult {
  /** Ready to send to LINE — either the model's answer or DEFAULT_REPLY. */
  text: string;
  usedDefault: boolean;
  finishReason: string;
  latencyMs: number;
  promptTokenCount: number;
  candidatesTokenCount: number;
  thoughtsTokenCount: number;
}

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
      return { ...telemetry, text: DEFAULT_REPLY, usedDefault: true };
    }

    const answer = sanitize(response.text ?? '');
    if (!answer) {
      return { ...telemetry, text: DEFAULT_REPLY, usedDefault: true };
    }

    return { ...telemetry, text: answer, usedDefault: false };
  } catch (error) {
    // No retry: the reply token expires long before a second attempt could land.
    console.error(
      JSON.stringify({
        tag: 'line-bot',
        event: 'gemini-error',
        error: error instanceof Error ? error.message : String(error),
        latencyMs: Date.now() - startedAt,
      }),
    );
    return {
      text: DEFAULT_REPLY,
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
