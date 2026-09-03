/**
 * ทดสอบการอ่านรูปเป็นรายการเตือน (feature 3) กับรูปจริง โดยไม่ต้องผ่าน LINE
 *
 *   npm run image:probe -- /path/to/appointment.png
 *   npm run image:probe -- /path/to/shifts.png image/png
 *
 * มีค่าใช้จ่ายจริง (เรียก vision model ~$0.001-0.004/รูป) — ใช้ก่อนแก้ prompt/schema
 * เพื่อเทียบผลก่อน/หลัง เหมือน llm:bench และ nlu:probe
 */
import { readFileSync } from 'node:fs';
import { parseImageForReminders } from '../src/nlu/parseImage.js';
import { confirmableItems } from '../src/reminders/draftService.js';

const [, , filePath, mimeArg] = process.argv;
if (!filePath) {
  console.error('ใช้งาน: npm run image:probe -- /path/to/image.png [mime]');
  process.exit(1);
}

const mime = mimeArg ?? (filePath.endsWith('.png') ? 'image/png' : 'image/jpeg');
const buf = readFileSync(filePath);

const out = await parseImageForReminders(buf.toString('base64'), mime);

if (!out.ok) {
  console.log(`❌ ${out.reason}: ${out.detail}`);
  process.exit(1);
}

const ok = confirmableItems(out.items);
console.log(`docType=${out.docType}  cost=$${out.costUsd.toFixed(6)}`);
console.log(`ยืนยันได้ ${ok.length}/${out.items.length} รายการ:\n`);

for (const item of out.items) {
  if (item.problem) {
    console.log(`  ❌ "${item.title}" — ${item.problem}`);
  } else if (item.kind === 'once') {
    console.log(`  ✓ [once] "${item.title}" → ${item.dueAtUtc?.toISOString()}`);
  } else {
    console.log(`  ✓ [recurring] "${item.title}" → ${item.rrule} @ นาที ${item.fireAtMinuteLocal}`);
  }
}

if (out.unclearNotes.length > 0) {
  console.log(`\n⚠️  ไม่ชัด: ${out.unclearNotes.join(' / ')}`);
}
