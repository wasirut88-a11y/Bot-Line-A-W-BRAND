import { NextResponse } from 'next/server';
import { messagingApi, validateSignature } from '@line/bot-sdk';
import type { webhook } from '@line/bot-sdk';
import { DEFAULT_REPLY, MAX_QUESTION_CHARS, requireEnv } from '@/lib/config';
import { getFaqCsv } from '@/lib/sheet';
import { askGemini } from '@/lib/gemini';

// Signature verification needs node:crypto, which the edge runtime lacks.
export const runtime = 'nodejs';
// Well above the ~10s budget, so Vercel never kills a request mid-reply.
export const maxDuration = 30;
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  // Raw text, not req.json(): the signature is computed over the exact bytes,
  // and a parse-then-restringify round trip would not reproduce them.
  const body = await req.text();
  const signature = req.headers.get('x-line-signature');

  if (!signature || !validateSignature(body, requireEnv('LINE_CHANNEL_SECRET'), signature)) {
    // Deliberately no body logging here — unverified input.
    return new NextResponse('invalid signature', { status: 401 });
  }

  try {
    const events: webhook.Event[] = JSON.parse(body).events ?? [];
    const textEvents = events.filter(isReplyableTextMessage);

    // Stickers, images, follows and the rest are dropped without a reply.
    if (textEvents.length > 0) {
      await Promise.allSettled(textEvents.map(handleTextMessage));
    }
  } catch (error) {
    console.error(
      JSON.stringify({
        tag: 'line-bot',
        event: 'handler-error',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  // Always 200. A 5xx makes LINE redeliver, and the customer gets the same
  // answer several times over.
  return NextResponse.json({ ok: true });
}

type TextMessageEvent = webhook.MessageEvent & {
  message: webhook.TextMessageContent;
  replyToken: string;
};

/**
 * The SDK marks `replyToken` optional because a few event kinds arrive without
 * one. No token means nothing to reply to, so those are filtered out here rather
 * than failing later at the send.
 */
function isReplyableTextMessage(event: webhook.Event): event is TextMessageEvent {
  return (
    event.type === 'message' &&
    event.message.type === 'text' &&
    typeof event.replyToken === 'string'
  );
}

async function handleTextMessage(event: TextMessageEvent): Promise<void> {
  const question = event.message.text.trim().slice(0, MAX_QUESTION_CHARS);
  if (!question) return; // Whitespace-only: not worth a model call.

  // Group and room sources carry no userId; the log falls back to a placeholder.
  const userId = event.source?.userId ?? 'unknown';
  let sheetCacheHit = false;
  let reply = DEFAULT_REPLY;
  let telemetry = {
    finishReason: 'SKIPPED',
    thoughtsTokenCount: 0,
    candidatesTokenCount: 0,
    promptTokenCount: 0,
    latencyMs: 0,
    usedDefault: true,
  };

  try {
    const faq = await getFaqCsv();
    sheetCacheHit = faq.cacheHit;

    const result = await askGemini(question, faq.csv);
    reply = result.text;
    telemetry = {
      finishReason: result.finishReason,
      thoughtsTokenCount: result.thoughtsTokenCount,
      candidatesTokenCount: result.candidatesTokenCount,
      promptTokenCount: result.promptTokenCount,
      latencyMs: result.latencyMs,
      usedDefault: result.usedDefault,
    };
  } catch (error) {
    // Only reachable when the sheet is unavailable and nothing is cached. Calling
    // Gemini with no FAQ would invite exactly the invented answers the prompt
    // forbids, so skip straight to the default reply.
    console.error(
      JSON.stringify({
        tag: 'line-bot',
        event: 'sheet-unavailable',
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  console.log(
    JSON.stringify({
      tag: 'line-bot',
      userId: userId.slice(0, 8),
      qLen: question.length,
      ...telemetry,
      sheetCacheHit,
    }),
  );

  await reply_(event.replyToken, reply);
}

async function reply_(replyToken: string, text: string): Promise<void> {
  try {
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: requireEnv('LINE_CHANNEL_ACCESS_TOKEN'),
    });
    await client.replyMessage({ replyToken, messages: [{ type: 'text', text }] });
  } catch (error) {
    // Reply tokens are single-use; a retry with the same token always fails.
    console.error(
      JSON.stringify({
        tag: 'line-bot',
        event: 'reply-failed',
        replyToken: replyToken.slice(0, 8),
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
