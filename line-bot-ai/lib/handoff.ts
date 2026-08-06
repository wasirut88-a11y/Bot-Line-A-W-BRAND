import { messagingApi } from '@line/bot-sdk';
import { requireEnv } from './config';
import { errorMessage, log, shortId } from './log';

/**
 * Keyword routing runs BEFORE Gemini, for three reasons: it costs nothing, it
 * cannot be talked out of the decision the way a model can, and it saves ~2s of
 * latency on exactly the messages where a fast acknowledgement matters most.
 *
 * The prompt also lists these cases in <out_of_scope_triggers>, which catches the
 * paraphrases this list misses. Two layers, deliberately.
 */
interface Trigger {
  /** Why this routes to a human — appears in the admin notification and logs. */
  reason: string;
  keywords: string[];
}

const TRIGGERS: Trigger[] = [
  {
    reason: 'ขอคุยกับคน',
    keywords: ['คุยกับคน', 'คุยกับแอดมิน', 'ขอแอดมิน', 'ขอเจ้าของ', 'แอดมินตัวจริง', 'คนจริง'],
  },
  {
    reason: 'ร้องเรียน/คืนเงิน',
    keywords: ['ร้องเรียน', 'ไม่พอใจ', 'คืนเงิน', 'คืนสินค้า', 'เปลี่ยนสินค้า', 'เคลม', 'ฟ้อง', 'หลอกลวง'],
  },
  {
    // A supplement shop must never let a model improvise around a possible
    // adverse reaction. This one is the reason handoff exists at all.
    reason: 'แจ้งอาการไม่พึงประสงค์',
    keywords: ['แพ้', 'ผลข้างเคียง', 'ผื่น', 'คลื่นไส้', 'อาเจียน', 'ท้องเสีย', 'วิงเวียน', 'แน่นหน้าอก'],
  },
  {
    reason: 'ขายส่ง/ตัวแทน',
    keywords: ['ขายส่ง', 'wholesale', 'ตัวแทน', 'ตัวแทนจำหน่าย', 'ซื้อจำนวนมาก', 'จำนวนเยอะ', 'แฟรนไชส์', 'franchise'],
  },
  {
    reason: 'สื่อ/PR',
    keywords: ['ติดต่อสื่อ', 'สัมภาษณ์', 'รีวิวลงเพจ', 'ขอ pr', 'ประชาสัมพันธ์'],
  },
];

export interface HandoffMatch {
  reason: string;
  keyword: string;
}

/**
 * Returns the matching trigger, or null. Matching is substring-based on a
 * lowercased copy so English keywords match regardless of case; Thai has no case
 * so it is unaffected.
 */
export function detectHandoff(message: string): HandoffMatch | null {
  const haystack = message.toLowerCase();
  for (const trigger of TRIGGERS) {
    const keyword = trigger.keywords.find((k) => haystack.includes(k.toLowerCase()));
    if (keyword) return { reason: trigger.reason, keyword };
  }
  return null;
}

/**
 * Best-effort push to the admin group. Never throws: the customer has already
 * been promised a callback, and failing to notify must not turn into a failed
 * webhook. A missing ADMIN_GROUP_ID is a warning, not an error — the bot is
 * designed to run without one.
 */
export async function notifyAdmin(
  userId: string | undefined,
  message: string,
  match: HandoffMatch,
): Promise<boolean> {
  const groupId = process.env.ADMIN_GROUP_ID;
  if (!groupId) {
    log.warn('handoff.no-admin-group', { reason: match.reason });
    return false;
  }

  try {
    const client = new messagingApi.MessagingApiClient({
      channelAccessToken: requireEnv('LINE_CHANNEL_ACCESS_TOKEN'),
    });
    await client.pushMessage({
      to: groupId,
      messages: [
        {
          type: 'text',
          // The full message goes to the admin group because they need it to act
          // on. It is not written to the logs.
          text: [
            '🔔 ลูกค้าต้องการคุยกับแอดมิน',
            `เหตุผล: ${match.reason}`,
            `ข้อความ: ${message}`,
            '',
            'ไปตอบที่: https://manager.line.biz/chats',
          ].join('\n'),
        },
      ],
    });
    return true;
  } catch (error) {
    log.error('handoff.notify-failed', {
      userId: shortId(userId),
      reason: match.reason,
      error: errorMessage(error),
    });
    return false;
  }
}
