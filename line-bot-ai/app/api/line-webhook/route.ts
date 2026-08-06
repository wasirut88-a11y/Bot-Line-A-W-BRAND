import { NextResponse } from 'next/server';
import { messagingApi, validateSignature } from '@line/bot-sdk';
import type { webhook } from '@line/bot-sdk';
import { DEFAULT_REPLY, HANDOFF_REPLY, MAX_QUESTION_CHARS, requireEnv } from '@/lib/config';
import { findRowById, getFaqCsv } from '@/lib/sheet';
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

    const work: Promise<unknown>[] = [];
    for (const event of events) {
      // Stickers, images, follows and the rest are dropped without a reply.
      if (event.type === 'join') work.push(handleJoin(event));
      else if (isReplyableTextMessage(event)) work.push(handleTextMessage(event, baseUrl(req)));
    }
    if (work.length > 0) await Promise.allSettled(work);
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
 * Only 1:1 chats are answered.
 *
 * The bot sits in the admin group so it can push handoff notifications there. If
 * it also replied to messages, every line the admins typed to each other would
 * cost a Gemini call and a reply nobody asked for.
 *
 * `replyToken` is optional on the SDK type because a few event kinds arrive
 * without one; no token means nothing to reply to.
 */
function isReplyableTextMessage(event: webhook.Event): event is TextMessageEvent {
  return (
    event.type === 'message' &&
    event.message.type === 'text' &&
    event.source?.type === 'user' &&
    typeof event.replyToken === 'string'
  );
}

/**
 * Fired when someone adds the bot to a group or multi-person chat.
 *
 * The group ID is only ever revealed here, and it is the value ADMIN_GROUP_ID
 * needs — so it goes to both the logs and the chat itself, because reading it off
 * your phone beats digging through Vercel logs during setup.
 *
 * The ID is an identifier, not a credential: pushing to a group still requires
 * the channel access token.
 */
async function handleJoin(event: webhook.JoinEvent): Promise<void> {
  const source = event.source;
  const id = source?.type === 'group' ? source.groupId : source?.type === 'room' ? source.roomId : undefined;

  log.info('joined', { sourceType: source?.type, id });

  if (!id) return;
  await send(event.replyToken, [
    {
      type: 'text',
      text: [
        'สวัสดีค่ะ แอดมินบอทเข้ากลุ่มแล้วนะคะ',
        '',
        'ID ของกลุ่มนี้คือ',
        id,
        '',
        'นำไปใส่เป็น ADMIN_GROUP_ID ใน Vercel แล้ว Redeploy เพื่อเปิดการแจ้งเตือนค่ะ',
      ].join('\n'),
    },
  ]);
}

/**
 * Where product images are served from. Taken from the request LINE just made
 * rather than an env var: it is by definition this deployment's public HTTPS
 * origin, so it is correct on production and previews alike with nothing to
 * configure or forget.
 */
function baseUrl(req: Request): string {
  const host = req.headers.get('host');
  return host ? `https://${host}` : '';
}

/**
 * Resolves the sheet's `image` cell to a URL LINE will accept — HTTPS, and JPEG
 * or PNG. A bare filename means public/products/; a full URL passes through so
 * the owner can point at images hosted anywhere.
 *
 * Returns null when the value cannot be served, so a typo in the sheet costs the
 * picture and not the reply.
 */
function imageUrl(image: string, base: string): string | null {
  if (!image) return null;
  const url = /^https?:\/\//i.test(image) ? image : `${base}/products/${image}`;
  if (!url.startsWith('https://')) return null;
  return /\.(jpe?g|png)$/i.test(url) ? url : null;
}

async function handleTextMessage(event: TextMessageEvent, base: string): Promise<void> {
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
  let sourceId = '';
  let photo: string | null = null;
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
    sourceId = result.sourceId;
    telemetry = {
      finishReason: result.finishReason,
      thoughtsTokenCount: result.thoughtsTokenCount,
      candidatesTokenCount: result.candidatesTokenCount,
      promptTokenCount: result.promptTokenCount,
      latencyMs: result.latencyMs,
      usedDefault: result.usedDefault,
    };

    // The model reports which row it answered from; the image comes from the
    // sheet, never from the model. It cannot invent a URL this way.
    const row = findRowById(faq.rows, sourceId);
    photo = row ? imageUrl(row.image, base) : null;
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
    sourceId,
    withImage: photo !== null,
    sheetCacheHit,
    totalMs: Date.now() - startedAt,
  });

  const messages: messagingApi.Message[] = [{ type: 'text', text: reply }];
  if (photo) {
    // Same file for both: the product shots are 800px and well under LINE's
    // 1MB preview ceiling, so a separate thumbnail would buy nothing.
    messages.push({ type: 'image', originalContentUrl: photo, previewImageUrl: photo });
  }
  await send(event.replyToken, messages);
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
