#!/usr/bin/env bash
#
# Installs rich-menu.json + rich-menu.jpg onto the LINE OA and makes it the
# default for every user.
#
#   ./scripts/install-rich-menu.sh
#
# Re-running creates a NEW menu and repoints the default at it; the old one stays
# on the account unused. Delete leftovers with:
#   curl -X DELETE https://api.line.me/v2/bot/richmenu/<id> -H "Authorization: Bearer $TOKEN"
set -euo pipefail

cd "$(dirname "$0")/.."

MENU_JSON="rich-menu.json"
MENU_IMAGE="rich-menu.jpg"

# The token lives in .env.local, never on the command line or in shell history.
if [[ -f .env.local ]]; then
  TOKEN=$(grep '^LINE_CHANNEL_ACCESS_TOKEN=' .env.local | cut -d= -f2-)
else
  TOKEN="${LINE_CHANNEL_ACCESS_TOKEN:-}"
fi

if [[ -z "${TOKEN:-}" ]]; then
  echo "❌ ไม่พบ LINE_CHANNEL_ACCESS_TOKEN — ใส่ใน .env.local ก่อน" >&2
  exit 1
fi

for cmd in curl jq; do
  command -v "$cmd" >/dev/null || { echo "❌ ต้องติดตั้ง $cmd ก่อน (brew install $cmd)" >&2; exit 1; }
done

[[ -f "$MENU_JSON" ]] || { echo "❌ ไม่พบ $MENU_JSON" >&2; exit 1; }
if [[ ! -f "$MENU_IMAGE" ]]; then
  echo "❌ ไม่พบ $MENU_IMAGE" >&2
  echo "   ต้องทำรูปขนาด 2500x1686 px บันทึกเป็น JPEG ชื่อ $MENU_IMAGE" >&2
  echo "   LINE ไม่รับ PNG ที่มีพื้นโปร่งใส" >&2
  exit 1
fi

echo "→ สร้าง rich menu..."
RESPONSE=$(curl -sS -X POST https://api.line.me/v2/bot/richmenu \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d @"$MENU_JSON")

MENU_ID=$(echo "$RESPONSE" | jq -r '.richMenuId // empty')
if [[ -z "$MENU_ID" ]]; then
  echo "❌ สร้างไม่สำเร็จ: $RESPONSE" >&2
  exit 1
fi
echo "  id: $MENU_ID"

echo "→ อัปโหลดรูป..."
curl -sS -X POST "https://api-data.line.me/v2/bot/richmenu/$MENU_ID/content" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: image/jpeg" \
  --data-binary @"$MENU_IMAGE" >/dev/null

echo "→ ตั้งเป็นเมนูเริ่มต้นของทุกคน..."
curl -sS -X POST "https://api.line.me/v2/bot/user/all/richmenu/$MENU_ID" \
  -H "Authorization: Bearer $TOKEN" >/dev/null

echo "✅ ติดตั้งเรียบร้อย: $MENU_ID"
echo "   ปิดแล้วเปิดแชท LINE ใหม่เพื่อให้เมนูขึ้น"
