# line-bot-ai

LINE bot for A&W BRAND. A customer messages the OA, the bot answers from a FAQ
kept in a Google Sheet, rephrased by Gemini. Anything it cannot answer from the
sheet becomes a hand-off message so a human admin picks it up.

Next.js 14 (App Router) + TypeScript, deployed on Vercel.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in all four values
npm run dev
```

| Variable                    | Where it comes from                                      |
| --------------------------- | -------------------------------------------------------- |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE Developers → channel → Messaging API                  |
| `LINE_CHANNEL_SECRET`       | LINE Developers → channel → Basic settings                 |
| `GEMINI_API_KEY`            | Google AI Studio → API keys                                |
| `SHEET_CSV_URL`             | Sheet → File → Share → Publish to web → this sheet → `.csv` |

## Scripts

```bash
npm run check:gemini              # credentials preflight through the real code path
npm run test:chat                 # 20-case conversation regression suite
npm run test:chat injection       # one category: direct paraphrase out-of-faq injection handoff
npm run richmenu                  # install rich-menu.json + rich-menu.jpg onto the OA
```

## Checking the credentials

```bash
npm run check:gemini                      # default question
npm run check:gemini "ส่งกี่วัน"           # your own question
```

Runs a real question through the production code path — `lib/sheet.ts` then
`lib/gemini.ts` — and prints `finishReason`, latency, and token counts. It uses
the live sheet when `SHEET_CSV_URL` is set and falls back to `faq-sample.csv`
otherwise, so the key can be checked before the sheet exists. Exits non-zero on
failure. Only the last 4 characters of the key are ever printed.

## The FAQ sheet

[`faq-sample.csv`](./faq-sample.csv) is the template — paste it into a Google
Sheet, publish that sheet as CSV, and put the URL in `SHEET_CSV_URL`.

| Column       | Notes                                                                  |
| ------------ | ---------------------------------------------------------------------- |
| `id`         | For debugging, e.g. `Q001`                                              |
| `category`   | `vitad` `cnight` `toothpaste` `shipping` `payment` `promotion` `contact` `safety` `general` |
| `question`   | The main question                                                       |
| `keywords`   | Comma-separated words customers actually type — this drives match quality |
| `answer`     | Brand-approved wording. Gemini may rephrase it but never changes numbers |
| `status`     | `active` reaches the prompt; `draft` is filtered out                     |
| `updated_at` | Change tracking                                                         |

Phone number and opening hours live in the sheet, not in code — editing a row
takes effect within 60 seconds with no redeploy.

**`faq-sample.csv` ships with placeholders that must be replaced before launch:**
`Q900` (phone number) and `Q901` (opening hours) contain `0X-XXX-XXXX` and
`XX.XX - XX.XX`.

Rows `Q910`–`Q912` cover pregnancy, existing conditions, and children. Their
answers must end with `ควรปรึกษาแพทย์ก่อนค่ะ`. Without these rows the bot falls
back to the default message on sensitive questions — safe, but a worse experience.

## Request flow

```
POST /api/line-webhook
  1. read raw body + x-line-signature
  2. verify signature ......................... fail → 401, body never logged
  3. keep only text messages with a replyToken   others → dropped silently
  4. detectHandoff() .......................... hit → notify admin, reply, STOP
  5. getFaqCsv() .............................. 60s cache, 5s timeout
  6. askGemini() .............................. 8s timeout
     finishReason !== STOP → DEFAULT_REPLY
  7. replyMessage()
  8. 200 — always
```

Step 4 runs before Gemini deliberately: keyword routing costs nothing, cannot be
argued out of its decision the way a model can, and saves ~2s on exactly the
messages where a fast acknowledgement matters most — complaints and adverse
reaction reports.

Step 7 is not optional. A 5xx makes LINE redeliver the event, and the customer
receives the same answer several times.

## Layout

```
app/api/line-webhook/route.ts   signature check, handoff routing, orchestration, logging
lib/config.ts                   every tunable — timeouts, model, limits
lib/prompt.ts                   system instruction: guardrails + reasoning protocol
lib/gemini.ts                   Gemini call, finishReason handling, sanitizing
lib/sheet.ts                    CSV fetch, RFC 4180 parse, status filter, cache
lib/handoff.ts                  keyword routing to a human + admin group notify
lib/flex-cards.ts               Flex Message builders
lib/log.ts                      structured logging helper
```

`CLAUDE.md` holds the repo conventions, `PRD.md` what the bot must and must not do.

## Design notes

- **`runtime = 'nodejs'`** — signature verification needs `node:crypto`, absent
  on edge. This is the most common cause of a failing LINE **Verify**.
- **`req.text()`, never `req.json()`** — the signature covers the exact bytes; a
  parse-then-restringify round trip does not reproduce them.
- **`<faq>` sits last in the system instruction** — everything before it is
  identical between requests, which is what context caching keys on, and the
  model reads the data before the task.
- **No `temperature` / `topP` / `topK`** — Google advises against setting these
  on Gemini 3.x; omitting them keeps the intended defaults.
- **`maxOutputTokens` is 1024, not 200** — Gemini 3.x counts thinking tokens
  against the output budget, so a small cap truncates mid-sentence.
- **`thinkingLevel: LOW`** — FAQ lookup needs recall, not reasoning, and the
  budget is ~10s end to end.
- **Sheet cache is per serverless instance.** Vercel may run several, each with
  its own copy, so at low traffic the sheet is fetched more often than the 60s
  TTL implies. Harmless at this scale.
- **Stale-while-error.** If the sheet fetch fails but a previous copy is cached,
  the old copy is used. With no cache at all, Gemini is skipped entirely — an
  empty FAQ would invite exactly the invented answers the prompt forbids.
- **Reply tokens are single-use.** A send is retried once, and only when the
  failure leaves the token unspent — a transport error or a 5xx. Retrying after a
  4xx is guaranteed to fail again and just burns the time budget.
- **Prompt injection defense is in `<guardrails>`, not after `<faq>`** — putting it
  last would work too, but it would break the cacheable prefix. The customer's
  message is framed as data to read, never instructions to follow.
- **The default reply must be sent verbatim.** "The FAQ has no row for this" is
  not the same as "this is not true", so the bot is forbidden from explaining the
  gap — that is how "no branch listed in Phuket" becomes "we have no Phuket branch".

## Logs

One JSON line per handled message, visible in Vercel → Logs:

```json
{"tag":"line-bot","userId":"Uabcdef1","qLen":26,"finishReason":"STOP",
 "thoughtsTokenCount":180,"candidatesTokenCount":42,"promptTokenCount":1300,
 "latencyMs":1450,"usedDefault":false,"sheetCacheHit":true}
```

`userId` is truncated to 8 characters. Message text, full user IDs, tokens and
API keys are never logged.

What to watch after launch:

| Signal                       | Meaning                                   |
| ---------------------------- | ----------------------------------------- |
| `thoughtsTokenCount` > 700   | Drop `THINKING_LEVEL` to `MINIMAL`         |
| `usedDefault` above 30%      | FAQ coverage is thin — add rows            |
| `latencyMs` p95 > 8000       | Lower `GEMINI_TIMEOUT_MS` or shorten the FAQ |

## Deploy

`vercel.json` pins `"framework": "nextjs"` so detection cannot land on the wrong
preset.

**This project lives in the `line-bot-ai/` subdirectory of the repo.** In Vercel →
Settings → General, set **Root Directory** to `line-bot-ai`, otherwise the build
runs at the repo root and finds nothing.

After pushing:

1. Vercel → Deployments — wait for `Ready`
2. Vercel → Settings → Environment Variables — all four present, **Production**
   ticked. Newly added variables need a **Redeploy**; Vercel does not hot-reload them.
3. LINE Developers → Messaging API:
   - Webhook URL = `https://<production-url>/api/line-webhook`
   - **Verify** → Success
   - **Use webhook** = ON
   - **Auto-reply messages** and **Greeting messages** = OFF, or customers get two replies
4. Test from a real phone: a question in the FAQ, one that isn't, a sensitive one
   (`ท้องกินได้ไหม`), and a sticker (must stay silent).

### If Verify fails

1. URL ends in `/api/line-webhook`
2. Root Directory is set to `line-bot-ai`
3. `LINE_CHANNEL_SECRET` matches the console — it is not the access token
4. The deployment is `Ready`, not still building
