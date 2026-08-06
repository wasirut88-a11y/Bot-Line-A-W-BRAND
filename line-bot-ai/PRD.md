# PRD · LINE Bot AI — A&W BRAND

## Goal

A&W BRAND sells three supplements through a LINE Official Account. Customers ask
the same handful of questions — price, how to take it, shipping, whether it is
safe while pregnant — at all hours, and a human cannot cover the night shift.

The bot answers those from an FAQ the owner maintains in a Google Sheet, and gets
out of the way the moment a question needs a person.

## Users

- **Customer** — messages the OA asking about price, dosage, shipping, payment,
  contact details, or safety.
- **Owner** — edits the Google Sheet from a phone when a price or promotion
  changes. No deploy, no developer.
- **Admin** — takes over when the bot hands off, via LINE Official Account Manager.

## Acceptance criteria

1. A customer message gets a reply within **5 seconds**, in natural Thai, drawn
   from the FAQ.
2. A question with no FAQ row gets the default reply — **never an invented answer**.
3. A paraphrase or synonym still finds the right FAQ row.
4. Numbers (price, shipping fee, phone, hours) are copied from the Sheet exactly —
   never rounded, never approximated.
5. Sheet temporarily unreachable → serve the last cached copy; if nothing is
   cached, reply default rather than asking Gemini with no data.
6. Gemini timeout or error → default reply, no retry, no customer-visible delay.
7. Non-text events (sticker, image, follow) → **no reply at all**.
8. A handoff trigger short-circuits before Gemini is called.

## Safety requirements — non-negotiable

This is a supplement business, so the bot carries regulatory risk that a
restaurant bot does not.

- Never claim a product treats, cures, prevents, or replaces medicine.
- Never tell a customer to stop or reduce a prescribed medication.
- Never diagnose.
- Pregnancy, breastfeeding, existing conditions, current medication, children,
  the elderly, pre/post surgery, allergy history → answer only from a directly
  matching FAQ row, always ending with advice to consult a doctor or pharmacist.
  No matching row → default reply. Never infer from a neighbouring row.
- **Reports of an adverse reaction or side effect must reach a human**, not the
  bot's own wording. This is a handoff trigger.

## Tone

- Warm and friendly, but still polite. Not stiff, not overfamiliar.
- Ends with **ค่ะ** or **นะคะ**. Never **ครับ** — the persona is consistent.
- At most one emoji per message, at the end, and not on every message.
- 1–3 sentences.

## Non-goals

- ❌ Multi-channel — one LINE OA
- ❌ Voice or image input — text only
- ❌ Checkout or payment collection in-bot — handoff to an admin instead
- ❌ Table booking / reservations — not this business
- ❌ Multi-language — Thai only, including when the customer writes in another language

## Out of scope for the bot → hand to a human

Complaints, refunds, adverse reactions, wholesale and reseller enquiries,
franchise, press, and any explicit "let me talk to a person".
