import type { messagingApi } from '@line/bot-sdk';
import type { FaqRow } from './sheet';

type FlexMessage = messagingApi.FlexMessage;

const BRAND = {
  ink: '#1A1410',
  accent: '#C0533A',
  muted: '#7A6E66',
};

/**
 * A tappable phone number beats a phone number the customer has to select and
 * copy, which is the whole reason this card exists rather than a text reply.
 *
 * The number and hours are pulled from the FAQ sheet — never hardcoded — so the
 * owner changing a row changes the card too.
 */
export function contactCard(phone: string, hours?: string): FlexMessage {
  const rows: Record<string, unknown>[] = [
    {
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'โทร', color: BRAND.muted, size: 'sm', flex: 1 },
        { type: 'text', text: phone, size: 'sm', color: BRAND.ink, flex: 4, weight: 'bold' },
      ],
    },
  ];

  if (hours) {
    rows.push({
      type: 'box',
      layout: 'baseline',
      spacing: 'sm',
      contents: [
        { type: 'text', text: 'เวลา', color: BRAND.muted, size: 'sm', flex: 1 },
        { type: 'text', text: hours, size: 'sm', color: BRAND.ink, flex: 4, wrap: true },
      ],
    });
  }

  return {
    type: 'flex',
    altText: `ติดต่อแอดมิน ${phone}`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'ติดต่อแอดมิน', weight: 'bold', size: 'lg', color: BRAND.ink },
          { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: BRAND.accent,
            height: 'sm',
            action: { type: 'uri', label: 'โทรเลย', uri: `tel:${phone.replace(/[^0-9+]/g, '')}` },
          },
        ],
      },
    },
  } as FlexMessage;
}

/**
 * Product list with prices. Left unwired on purpose: the FAQ sheet stores prices
 * as free text inside an answer sentence, and parsing a baht figure back out of
 * Thai prose is the kind of guess this bot is built to avoid. Wire this up once
 * the sheet grows a proper products tab with `name` and `price` columns.
 */
export function productListCard(items: { name: string; price: number }[]): FlexMessage {
  return {
    type: 'flex',
    altText: 'สินค้าและราคา',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'สินค้าและราคา', weight: 'bold', size: 'lg', color: BRAND.ink },
          {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: items.map((item) => ({
              type: 'box',
              layout: 'horizontal',
              contents: [
                { type: 'text', text: item.name, size: 'sm', flex: 3, wrap: true, color: BRAND.ink },
                {
                  type: 'text',
                  text: `${item.price} ฿`,
                  size: 'sm',
                  align: 'end',
                  color: BRAND.accent,
                  weight: 'bold',
                  flex: 1,
                },
              ],
            })),
          },
        ],
      },
    },
  } as FlexMessage;
}

/**
 * Finds a Thai phone number in the contact rows of the FAQ.
 *
 * Returns null rather than guessing when nothing matches — callers fall back to a
 * plain text reply, so a sheet without a recognizable number degrades quietly
 * instead of sending a card with a broken call button.
 */
export function findPhone(rows: FaqRow[]): string | null {
  const pattern = /0\d[\d\s-]{7,12}\d/;
  for (const row of rows) {
    if (row.category !== 'contact') continue;
    const match = row.answer.match(pattern);
    if (match) return match[0].trim();
  }
  return null;
}

/** Opening-hours text from the contact rows, if a row mentions a time range. */
export function findHours(rows: FaqRow[]): string | null {
  for (const row of rows) {
    if (row.category !== 'contact') continue;
    if (/\d{1,2}[:.]\d{2}\s*-\s*\d{1,2}[:.]\d{2}/.test(row.answer)) return row.answer;
  }
  return null;
}
