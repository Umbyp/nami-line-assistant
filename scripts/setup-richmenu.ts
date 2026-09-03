/**
 * ตั้ง rich menu เริ่มต้นให้บอท (4 ปุ่ม: แจ้งเตือน / โน้ต-ไฟล์ / ตั้งค่า / ช่วยเหลือ)
 *
 * รันแบบ manual ตอน deploy หรือทุกครั้งที่แก้ผังปุ่ม — ไม่ใช่ส่วนหนึ่งของ webhook/worker runtime
 *   npm run richmenu:setup
 *
 * idempotent: ลบ rich menu เก่าที่ชื่อ (name) ตรงกับ RICHMENU_NAME ก่อนเสมอ
 * รันซ้ำกี่ครั้งก็ได้ผลลัพธ์เดียวกัน ไม่สร้างรายการซ้ำค้างไว้
 *
 * หมายเหตุ: rich menu แสดงเฉพาะแชท 1:1 เท่านั้น (ข้อจำกัดของ LINE) ไม่โผล่ในกลุ่ม
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { lineClient, lineBlobClient } from '../src/line/client.js';
import { buildRichMenuRequest, RICHMENU_NAME, RICHMENU_SIZE } from '../src/richmenu/build.js';
import { logger } from '../src/lib/logger.js';

const execFileAsync = promisify(execFile);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATE_HTML = path.resolve(__dirname, '../assets/richmenu/menu.html');

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  'google-chrome',
  'chromium',
  'chromium-browser',
];

/**
 * เรนเดอร์ menu.html เป็น PNG ขนาดพอดี (2500x1686) ด้วย headless Chrome
 *
 * ทำไมใช้ Chrome แทนไลบรารีวาดภาพ (เช่น node-canvas/sharp): ต้องพิมพ์ข้อความไทยให้ถูก
 * ตัวเรนเดอร์ข้อความของแพลตฟอร์ม (เช่น PIL บน macOS) จัดสระ/วรรณยุกต์ไทยผิดรูป
 * ส่วน Chrome ใช้เอนจินเรนเดอร์เว็บจริงจึงจัดตัวอักษรไทยถูกต้อง
 */
async function renderMenuImage(): Promise<Buffer> {
  const outPath = path.join(tmpdir(), `nami-richmenu-${Date.now()}.png`);
  let lastErr: unknown;

  for (const chrome of CHROME_CANDIDATES) {
    try {
      await execFileAsync(chrome, [
        '--headless',
        '--disable-gpu',
        '--hide-scrollbars',
        `--screenshot=${outPath}`,
        `--window-size=${RICHMENU_SIZE.width},${RICHMENU_SIZE.height}`,
        '--force-device-scale-factor=1',
        `file://${TEMPLATE_HTML}`,
      ]);
      const buf = await readFile(outPath);
      await unlink(outPath).catch(() => undefined);
      return buf;
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(
    `หา Chrome/Chromium ไม่เจอ (ลองแล้ว: ${CHROME_CANDIDATES.join(', ')}) — ` +
      `ติดตั้ง Chrome หรือแก้ CHROME_CANDIDATES ใน scripts/setup-richmenu.ts\n` +
      `error ล่าสุด: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

async function main(): Promise<void> {
  console.log(`กำลังเรนเดอร์รูปเมนูจาก ${TEMPLATE_HTML} ...`);
  const image = await renderMenuImage();
  console.log(`เรนเดอร์เสร็จ (${image.length} bytes)`);

  // ── ลบ rich menu เก่าชื่อเดียวกันก่อน (idempotent) ──
  const existing = await lineClient.getRichMenuList();
  for (const m of existing.richmenus) {
    if (m.name === RICHMENU_NAME) {
      console.log(`ลบ rich menu เก่า: ${m.richMenuId}`);
      await lineClient.deleteRichMenu(m.richMenuId);
    }
  }

  // ── สร้างใหม่ ──
  const created = await lineClient.createRichMenu(buildRichMenuRequest());
  console.log(`สร้าง rich menu แล้ว: ${created.richMenuId}`);

  // ── อัปโหลดรูป ──
  await lineBlobClient.setRichMenuImage(
    created.richMenuId,
    new Blob([new Uint8Array(image)], { type: 'image/png' }),
  );
  console.log('อัปโหลดรูปเมนูสำเร็จ');

  // ── ตั้งเป็นเมนูเริ่มต้น ──
  await lineClient.setDefaultRichMenu(created.richMenuId);
  console.log(`ตั้งเป็นเมนูเริ่มต้นแล้ว: ${created.richMenuId}`);
  console.log('\nเสร็จแล้ว — เปิดแชท 1:1 กับนามิใหม่เพื่อดูเมนู (rich menu ไม่โผล่ในกลุ่ม)');
}

main().catch((err) => {
  logger.fatal({ err }, 'ตั้ง rich menu ไม่สำเร็จ');
  console.error(err);
  process.exit(1);
});
