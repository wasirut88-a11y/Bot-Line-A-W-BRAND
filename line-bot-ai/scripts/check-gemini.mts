/**
 * Preflight check: does GEMINI_API_KEY actually work, against this bot's real
 * prompt and FAQ? Run with `npm run check:gemini`.
 *
 * Deliberately goes through lib/gemini.ts rather than calling the API directly,
 * so a pass here means the production path works — not just that the key is valid.
 */
import { readFileSync } from 'node:fs';
import { MODEL, THINKING_LEVEL, MAX_OUTPUT_TOKENS } from '../lib/config';

process.loadEnvFile('.env.local');

const question = process.argv[2] ?? 'วีต้า-ดี พลัส ราคาเท่าไหร่';

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

const key = process.env.GEMINI_API_KEY;
if (!key) fail('GEMINI_API_KEY ไม่ได้ตั้งใน .env.local');
console.log(`key      : ...${key.slice(-4)} (${key.length} ตัวอักษร)`);
console.log(`model    : ${MODEL}`);
console.log(`thinking : ${THINKING_LEVEL}, maxOutputTokens ${MAX_OUTPUT_TOKENS}`);

// Prefer the live sheet so this also proves SHEET_CSV_URL works; fall back to
// the local sample so a missing sheet doesn't block checking the key itself.
let faqCsv: string;
if (process.env.SHEET_CSV_URL) {
  const { getFaqCsv } = await import('../lib/sheet');
  try {
    const faq = await getFaqCsv();
    faqCsv = faq.csv;
    console.log(`faq      : live sheet, ${faq.csv.split('\n').length - 1} active rows`);
  } catch (error) {
    fail(`ดึง Google Sheet ไม่ได้: ${error instanceof Error ? error.message : String(error)}`);
  }
} else {
  faqCsv = readFileSync('faq-sample.csv', 'utf8');
  console.log('faq      : faq-sample.csv (ไม่ได้ตั้ง SHEET_CSV_URL)');
}

console.log(`\nถาม: ${question}`);

const { askGemini } = await import('../lib/gemini');
const result = await askGemini(question, faqCsv);

console.log('\n--- ผลลัพธ์ ---');
console.log(`ตอบ            : ${result.text}`);
console.log(`finishReason   : ${result.finishReason}`);
console.log(`usedDefault    : ${result.usedDefault}`);
console.log(`latencyMs      : ${result.latencyMs}`);
console.log(
  `tokens         : prompt ${result.promptTokenCount} / thoughts ${result.thoughtsTokenCount} / output ${result.candidatesTokenCount}`,
);

if (result.finishReason === 'ERROR') {
  fail('เรียก Gemini ไม่สำเร็จ — ดู gemini-error ด้านบนว่าเป็นเรื่อง key, quota หรือชื่อ model');
}
if (result.usedDefault) {
  console.log(
    '\n⚠️  key ใช้ได้ แต่ตอบด้วย default message — ปกติแปลว่า FAQ ไม่มีคำตอบสำหรับคำถามนี้',
  );
  process.exit(0);
}

// The thresholds the brief says to watch once traffic is real.
if (result.thoughtsTokenCount > 700) {
  console.log('\n⚠️  thoughtsTokenCount > 700 — พิจารณาลด THINKING_LEVEL เป็น MINIMAL');
}
if (result.latencyMs > 8000) {
  console.log('\n⚠️  latency เกิน 8 วินาที — เสี่ยง replyToken หมดอายุ');
}
console.log('\n✅ key ใช้ได้ และตอบจาก FAQ ได้จริง');
