import { NextResponse } from 'next/server';
import { messagingApi, validateSignature } from '@line/bot-sdk';
import type { webhook } from '@line/bot-sdk';
import { DEFAULT_REPLY, HANDOFF_REPLY, MAX_QUESTION_CHARS, requireEnv } from '@/lib/config';
import { getFaqCsv } from '@/lib/sheet';
import { askGemini } from '@/lib/gemini';
import { detectHandoff, notifyAdmin } from '@/lib/handoff';
import { contactCard, findHours, findPhone } from '@/lib/flex-cards';
import { errorMessage, log, shortId } from '@/lib/log';

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
    log.warn('webhook.invalid-signature');
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
    log.error('webhook.error', { error: errorMessage(error) });
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
  const userId = event.source?.userId;
  const startedAt = Date.now();

  // Handoff is checked before anything else: it costs nothing, cannot be argued
  // out of the decision the way a model can, and skips ~2s of latency on exactly
  // the messages where a fast acknowledgement matters most.
  const match = detectHandoff(question);
  if (match) {
    const notified = await notifyAdmin(userId, question, match);
    await replyHandoff(event.replyToken);
    log.info('handoff.routed', {
      userId: shortId(userId),
      qLen: question.length,
      reason: match.reason,
      adminNotified: notified,
      latencyMs: Date.now() - startedAt,
    });
    return;
  }

  let reply = DEFAULT_REPLY;
  let sheetCacheHit = false;
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
    log.error('sheet.unavailable', { error: errorMessage(error) });
  }

  log.info('reply.sent', {
    userId: shortId(userId),
    qLen: question.length,
    ...telemetry,
    sheetCacheHit,
    totalMs: Date.now() - startedAt,
  });

  await replyText(event.replyToken, reply);
}

/**
 * Handoff answers with a tappable contact card when the sheet has a phone number
 * in it, and plain text otherwise. The fallback matters: a sheet edit that breaks
 * the number format should cost the customer a call button, not the reply.
 */
async function replyHandoff(replyToken: string): Promise<void> {
  try {
    const faq = await getFaqCsv();
    const phone = findPhone(faq.rows);
    if (phone) {
      await send(replyToken, [
        { type: 'text', text: HANDOFF_REPLY },
        contactCard(phone, findHours(faq.rows) ?? undefined),
      ]);
      return;
    }
  } catch (error) {
    log.warn('handoff.card-skipped', { error: errorMessage(error) });
  }
  await replyText(replyToken, HANDOFF_REPLY);
}

async function replyText(replyToken: string, text: string): Promise<void> {
  await send(replyToken, [{ type: 'text', text }]);
}

async function send(replyToken: string, messages: messagingApi.Message[]): Promise<void> {
  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: requireEnv('LINE_CHANNEL_ACCESS_TOKEN'),
  });

  // Two attempts, and only when the first failed in a way that leaves the token
  // unspent — a transport error or a 5xx. LINE reply tokens are single-use, so
  // retrying after a 4xx is guaranteed to fail again and just burns the budget.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await client.replyMessage({ replyToken, messages });
      return;
    } catch (error) {
      const status = httpStatus(error);
      const retryable = status === undefined || status >= 500;
      if (!retryable || attempt === 1) {
        log.error('reply.failed', {
          replyToken: replyToken.slice(0, 8),
          status,
          retried: attempt > 0,
          error: errorMessage(error),
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
}

/** Pulls the HTTP status off an SDK error, when there is one. */
function httpStatus(error: unknown): number | undefined {
  const status = (error as { status?: unknown })?.status;
  return typeof status === 'number' ? status : undefined;
}
