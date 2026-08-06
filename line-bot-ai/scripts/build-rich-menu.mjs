#!/usr/bin/env node
/**
 * Renders rich-menu.jpg from HTML via headless Chrome.
 *
 *   npm run richmenu:build
 *
 * The cell geometry here is generated from rich-menu.json, so the artwork and
 * the tap targets can never drift apart — change a bound in the JSON and the
 * image follows.
 *
 * Drop product photos in assets/rich-menu/ to fill the top row:
 *   veta-d.webp · z-night.webp · confident.webp · logo.png (optional)
 * Anything missing renders as a labelled placeholder so the layout stays visible.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const assetsDir = join(root, 'assets', 'rich-menu');
const outJpg = join(root, 'rich-menu.jpg');
const tmpHtml = join(root, '.rich-menu.tmp.html');
const tmpPng = join(root, '.rich-menu.tmp.png');

/**
 * Brand palette — the one place to change the look.
 *
 * The greens are taken from the A&W brush logo. `productBg` is pure white on
 * purpose: the product shots are cut out on white, so anything tinted would
 * show as a visible square around each bottle.
 */
const PALETTE = {
  productBg: '#FFFFFF',
  ink: '#1F2A21',
  muted: '#7C8A80',
  accent: '#4E9E52',
  accentDeep: '#3D7F41',
  actionText: '#FFFFFF',
  divider: 'rgba(31, 42, 33, 0.10)',
};

/** Cell content, in the same order as rich-menu.json areas. */
const CELLS = [
  { kind: 'product', image: 'veta-d.webp', title: 'วีต้า-ดี พลัส', sub: 'บำรุงดวงตา' },
  { kind: 'product', image: 'z-night.webp', title: 'ซี-ไนท์', sub: 'เพื่อการนอน' },
  { kind: 'product', image: 'confident.webp', title: 'คอนฟิเด้นท์', sub: 'ยาสีฟันสมุนไพร' },
  { kind: 'action', icon: 'truck', title: 'การจัดส่ง', sub: 'ส่งกี่วัน ค่าส่ง' },
  { kind: 'action', icon: 'card', title: 'ชำระเงิน', sub: 'โอน · ปลายทาง' },
  { kind: 'action', icon: 'chat', title: 'คุยกับแอดมิน', sub: 'ติดต่อเจ้าหน้าที่' },
];

/**
 * Inline stroke icons rather than emoji. Emoji render in Apple's house style —
 * a cartoon truck and a credit card with legible fake text on it — which reads
 * as clip art next to real product photography.
 */
const ICONS = {
  truck: `<path d="M3 17V7a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v10M14 10h4l3 3.5V17M3 17h2m4 0h6m4 0h2"/>
          <circle cx="7" cy="18.5" r="2"/><circle cx="17.5" cy="18.5" r="2"/>`,
  card: `<rect x="2.5" y="5.5" width="19" height="13" rx="2.5"/><path d="M2.5 10h19M6 14.5h4"/>`,
  chat: `<path d="M20.5 12.2c0 4-3.8 7.2-8.5 7.2-1 0-2-.15-2.9-.42L4 20.5l1.2-3.4A6.9 6.9 0 0 1 3.5 12.2C3.5 8.2 7.3 5 12 5s8.5 3.2 8.5 7.2Z"/>
         <path d="M9 12h.01M12 12h.01M15 12h.01" stroke-width="2.6" stroke-linecap="round"/>`,
};

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function dataUri(file) {
  const path = join(assetsDir, file);
  if (!existsSync(path)) return null;
  const ext = extname(file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
  return `data:${mime};base64,${readFileSync(path).toString('base64')}`;
}

const menu = JSON.parse(readFileSync(join(root, 'rich-menu.json'), 'utf8'));
const { width, height } = menu.size;

if (menu.areas.length !== CELLS.length) {
  console.error(
    `❌ rich-menu.json มี ${menu.areas.length} ปุ่ม แต่ CELLS ในสคริปต์มี ${CELLS.length} — ต้องเท่ากัน`,
  );
  process.exit(1);
}

const missing = [];
const cells = menu.areas.map((area, i) => {
  const cell = CELLS[i];
  const src = cell.kind === 'product' ? dataUri(cell.image) : null;
  if (cell.kind === 'product' && !src) missing.push(cell.image);
  return { ...cell, ...area.bounds, src };
});

const logo = dataUri('logo.png') ?? dataUri('logo.jpg');

const html = `<!doctype html>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body { width: ${width}px; height: ${height}px; overflow: hidden; }
  body {
    font-family: "Sukhumvit Set", "Thonburi", sans-serif;
    background: ${PALETTE.productBg};
    position: relative;
    -webkit-font-smoothing: antialiased;
  }
  .cell { position: absolute; display: flex; flex-direction: column;
          align-items: center; justify-content: center; overflow: hidden; }

  /* Top row — product photo above the name, photo given the bulk of the cell. */
  .product { background: ${PALETTE.productBg}; border-right: 3px solid ${PALETTE.divider};
             padding: 34px 28px 50px; }
  .shot { flex: 1; width: 100%; display: flex; align-items: center; justify-content: center;
          min-height: 0; margin-bottom: 20px; overflow: hidden; }
  /* Scaled past the frame on purpose: the source shots carry a wide white
     margin, and the cell is white too, so cropping it is invisible and the
     bottle ends up reading at a usable size. No drop-shadow — these are opaque
     rectangles, so it would draw a grey box rather than hug the product. */
  .shot img { width: 100%; height: 100%; object-fit: contain; transform: scale(1.16); }
  .ph { width: 66%; height: 78%; border-radius: 28px; border: 5px dashed ${PALETTE.muted};
        display: flex; align-items: center; justify-content: center; opacity: 0.55;
        color: ${PALETTE.muted}; font-size: 34px; text-align: center; padding: 20px; }
  .product .title { font-size: 76px; font-weight: 700; color: ${PALETTE.ink}; line-height: 1.1; }
  .product .sub { font-size: 40px; color: ${PALETTE.muted}; margin-top: 8px; }

  /* Bottom row — solid brand block, icon disc over label. */
  .action { background: ${PALETTE.accent}; color: ${PALETTE.actionText};
            border-right: 3px solid rgba(255,255,255,0.18); }
  .action .disc { width: 210px; height: 210px; border-radius: 50%;
                  background: rgba(255,255,255,0.14); display: flex;
                  align-items: center; justify-content: center; margin-bottom: 40px; }
  .action .disc svg { width: 116px; height: 116px; }
  .action .title { font-size: 68px; font-weight: 700; }
  .action .sub { font-size: 37px; opacity: 0.86; margin-top: 6px; }

  .cell.edge { border-right: none; }

  /* One hairline separating the product row from the action row. */
  .split { position: absolute; left: 0; width: ${width}px; height: 3px;
           background: ${PALETTE.divider}; }

  .logo { position: absolute; top: 34px; left: 50%; transform: translateX(-50%);
          height: 78px; z-index: 5; opacity: 0.96; }
</style>
${logo ? `<img class="logo" src="${logo}">` : ''}
${cells
  .map((c, i) => {
    const edge = c.x + c.width >= width ? ' edge' : '';
    const pos = `left:${c.x}px;top:${c.y}px;width:${c.width}px;height:${c.height}px;`;
    if (c.kind === 'product') {
      const art = c.src
        ? `<img src="${c.src}">`
        : `<div class="ph">วางรูป<br>${c.image}</div>`;
      return `<div class="cell product${edge}" style="${pos}">
        <div class="shot">${art}</div>
        <div class="title">${c.title}</div>
        <div class="sub">${c.sub}</div>
      </div>`;
    }
    return `<div class="cell action${edge}" style="${pos}">
      <div class="disc"><svg viewBox="0 0 24 24" fill="none" stroke="#fff"
        stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[c.icon]}</svg></div>
      <div class="title">${c.title}</div>
      <div class="sub">${c.sub}</div>
    </div>`;
  })
  .join('\n')}
<div class="split" style="top:${menu.areas[0].bounds.height}px"></div>
`;

if (!existsSync(assetsDir)) mkdirSync(assetsDir, { recursive: true });
writeFileSync(tmpHtml, html);

if (!existsSync(CHROME)) {
  console.error(`❌ ไม่พบ Google Chrome ที่ ${CHROME}`);
  process.exit(1);
}

execFileSync(
  CHROME,
  [
    '--headless',
    '--disable-gpu',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--window-size=${width},${height}`,
    `--screenshot=${tmpPng}`,
    `file://${tmpHtml}`,
  ],
  { stdio: 'ignore' },
);

// LINE accepts PNG, but a photo-heavy menu is far smaller as JPEG and the 1MB
// ceiling is easy to hit once real product shots go in.
execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '78', tmpPng, '--out', outJpg], {
  stdio: 'ignore',
});

const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', outJpg]).toString();
const w = Number(dims.match(/pixelWidth:\s*(\d+)/)?.[1]);
const h = Number(dims.match(/pixelHeight:\s*(\d+)/)?.[1]);
const kb = Math.round(statSync(outJpg).size / 1024);

unlinkSync(tmpHtml);
unlinkSync(tmpPng);

console.log(`✅ rich-menu.jpg — ${w} x ${h} px, ${kb} KB`);

let bad = false;
if (w !== width || h !== height) {
  console.error(`❌ ขนาดไม่ตรง ต้องเป็น ${width} x ${height}`);
  bad = true;
}
// LINE rejects anything above 1MB outright.
if (kb > 1024) {
  console.error(`❌ ไฟล์ใหญ่เกิน 1MB — ลด formatOptions ในสคริปต์ลง`);
  bad = true;
}
if (missing.length > 0) {
  console.log(`\n⚠️  ยังไม่มีรูปสินค้า ${missing.length} รูป — ตอนนี้เป็นกรอบ placeholder`);
  for (const file of missing) console.log(`   วางไฟล์ที่ assets/rich-menu/${file}`);
  console.log('   รูปสี่เหลี่ยมจัตุรัส พื้นหลังโปร่งใส (PNG) หรือพื้นขาว จะสวยที่สุด');
}
if (bad) process.exit(1);
console.log('\nดูรูปแล้วพอใจ → ติดตั้งด้วย: npm run richmenu');
