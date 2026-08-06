# CLAUDE.md — LINE Bot AI Project

## What we're building

LINE Official Account bot for **A&W BRAND** — a Thai supplement shop. Answers
customers 24/7 by reading an FAQ from a public Google Sheet and having Gemini
rephrase the brand-approved answer. Anything outside the FAQ is handed to a human.

## Business facts

Products (three, all in the FAQ sheet):

| Product | What it is |
| ------- | ---------- |
| วีต้า-ดี พลัส | อาหารเสริมบำรุงดวงตา — the flagship |
| ซี-ไนท์ | อาหารเสริมสำหรับการนอน |
| ยาสีฟันสมุนไพรคอนฟิเด้นท์ | herbal toothpaste |

Bot persona: calls itself **แอดมิน**, calls the customer **คุณลูกค้า**.

**Prices, phone number, opening hours and shipping terms live in the Sheet, never
in code.** The owner edits a row and it takes effect within 60 seconds. If you
find yourself typing a baht figure into a `.ts` file, stop — it belongs in the Sheet.

## Stack — locked

- Next.js 14 App Router + TypeScript
- `@line/bot-sdk` **v11** for the Messaging API
- `@google/genai` **v2** for Gemini, model `gemini-3.5-flash`
- Google Sheet published as CSV for the FAQ
- Vercel, Hobby tier, **Root Directory = `line-bot-ai`**
- npm (not pnpm — the lockfile in this repo is `package-lock.json`)

## Repo conventions

```
app/api/line-webhook/route.ts   verify signature → handoff check → FAQ → Gemini → reply
lib/config.ts                   every tunable: timeouts, model, limits
lib/prompt.ts                   the system instruction
lib/gemini.ts                   Gemini call, finishReason gating, sanitizing
lib/sheet.ts                    CSV fetch, RFC 4180 parse, status filter, cache
lib/handoff.ts                  Smart Handoff trigger detection + admin notify
lib/flex-cards.ts               Flex Message builders
lib/log.ts                      structured logging helper
scripts/check-gemini.mts        preflight credential check
scripts/test-conversations.mts  conversation regression suite
```

## Env vars (Vercel → Production)

- `LINE_CHANNEL_ACCESS_TOKEN`
- `LINE_CHANNEL_SECRET`
- `GEMINI_API_KEY`
- `SHEET_CSV_URL`
- `ADMIN_GROUP_ID` — optional; without it handoff still replies, it just cannot notify

## Don'ts

- ❌ Hardcode any token or key — use env vars
- ❌ Hardcode prices, phone, hours — they belong in the Sheet
- ❌ Skip signature verification
- ❌ Read the body with `req.json()` — signature covers the raw bytes, use `req.text()`
- ❌ Skip the timeout on Gemini — the webhook must answer within ~10s
- ❌ Cache the FAQ longer than 60s — owner edits should show up fast
- ❌ Log full message text or full userId — PII; log metadata only
- ❌ Return 5xx from the webhook — LINE redelivers and the customer gets duplicates
- ❌ Retry a `replyToken` after a 4xx — tokens are single-use and already spent
- ❌ Set `temperature` / `topP` / `topK` — Google advises against it on Gemini 3.x

## Verified environment facts

These were checked against the installed packages, not assumed:

- `@line/bot-sdk` v11 exposes webhook types under the `webhook.*` namespace
  (`webhook.Event`, `webhook.MessageEvent`, `webhook.TextMessageContent`), and the
  client is `messagingApi.MessagingApiClient` — **not** the old `new Client({...})`.
- `replyToken` and `source` are optional on `webhook.MessageEvent`.
- `@google/genai` v2 takes `thinkingConfig.thinkingLevel` as the `ThinkingLevel`
  enum, not a string, and supports `abortSignal` directly in `config`.
- Gemini API keys now issue with an **`AQ.` prefix**, not the legacy `AIza`. The
  SDK does not validate the prefix — do not add a check that does.
