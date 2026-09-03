/**
 * วัดผลโมเดลกับงานจริงของนามิ ก่อนจะเปลี่ยน LLM_MODEL_* ใน .env
 *
 *   npm run llm:bench                                    # ใช้โมเดลจาก .env
 *   npm run llm:bench -- google/gemini-2.5-flash-lite openai/gpt-5-nano
 *
 * มีค่าใช้จ่ายจริง (หลักสตางค์) — สคริปต์จะรวมยอดให้ท้ายรายงาน
 *
 * เหตุผลที่ต้องมี: ตัวถูกทำ NLU ข้อความได้ดี แต่ "อ่านตารางในรูป" พลาดคอลัมน์
 * ถ้าจะลดต้นทุนด้วยการเปลี่ยนโมเดล ต้องรันตัวนี้ก่อนเสมอ
 */
import { z } from 'zod';
import { completeStructured } from '../src/llm/chat.js';
import { env } from '../src/config/env.js';

const NOW_CONTEXT =
  'วันนี้คือวันพฤหัสบดีที่ 3 กันยายน 2026 เวลา 10:30 timezone Asia/Bangkok';

const SYSTEM = [
  NOW_CONTEXT,
  'หน้าที่: แปลงข้อความภาษาไทยของผู้ใช้เป็นข้อมูลการตั้งเตือน',
  '- kind=once ให้เติม dueAtLocal, ปล่อย rrule เป็น null',
  '- kind=recurring ให้เติม rrule + fireAtMinuteLocal, ปล่อย dueAtLocal เป็น null',
  '- ถ้าเวลาผ่านไปแล้วในวันนี้ ให้เลื่อนเป็นวันถัดไป',
  '- ปีในเอกสารไทยมักเป็น พ.ศ. ต้องแปลงเป็น ค.ศ. (พ.ศ. - 543)',
  '- ถ้าไม่มั่นใจให้ confidence ต่ำ ห้ามเดา',
].join('\n');

// ทุก field เป็น .nullable() ไม่ใช่ .optional() เพราะ strict mode ต้องมีทุก key
const ReminderGuess = z.object({
  intent: z.enum(['create_reminder', 'search_vault', 'list_reminders', 'unknown']),
  title: z.string(),
  kind: z.enum(['once', 'recurring']).nullable(),
  dueAtLocal: z.string().nullable(),
  rrule: z.string().nullable(),
  fireAtMinuteLocal: z.number().int().nullable(),
  confidence: z.number(),
});

const CASES: Array<{ text: string; expect: string }> = [
  { text: 'เตือนกินยาหลังอาหารเย็น 18.00', expect: 'once 2026-09-03T18:00' },
  { text: 'ทุกวันจันทร์-ศุกร์ 8 โมง เตือนส่งรายงาน', expect: 'recurring BYDAY=MO..FR, minute 480' },
  { text: 'พรุ่งนี้บ่าย 3 ประชุมกับลูกค้า', expect: 'once 2026-09-04T15:00' },
  { text: 'ทุกวันที่ 25 เตือนจ่ายค่าบัตรเครดิต', expect: 'recurring MONTHLY BYMONTHDAY=25' },
  { text: 'หาไฟล์สัญญาที่ส่งเมื่อเดือนก่อน', expect: 'search_vault' },
  { text: 'เตือนตอนเย็นๆ นะ', expect: `confidence < ${env.NLU_CONFIDENCE_THRESHOLD}` },
];

const models = process.argv.slice(2);
if (models.length === 0) models.push(env.LLM_MODEL_TEXT);

for (const model of models) {
  console.log('='.repeat(92));
  console.log(`MODEL: ${model}`);
  console.log('='.repeat(92));
  let total = 0;

  for (const c of CASES) {
    const out = await completeStructured({
      name: 'reminder_guess',
      schema: ReminderGuess,
      system: SYSTEM,
      user: c.text,
      model,
    });
    total += out.costUsd;

    console.log(`\n▸ ${c.text}`);
    console.log(`  คาดหวัง: ${c.expect}`);
    if (!out.ok) {
      console.log(`  ❌ ${out.reason}: ${out.detail}`);
      continue;
    }
    const d = out.data;
    const low = d.confidence < env.NLU_CONFIDENCE_THRESHOLD;
    console.log(`  intent=${d.intent} kind=${d.kind} conf=${d.confidence}${low ? ' → จะถามกลับ' : ''}`);
    console.log(`  title=${JSON.stringify(d.title)}`);
    console.log(`  due=${d.dueAtLocal} rrule=${d.rrule} minute=${d.fireAtMinuteLocal}`);
    console.log(`  ($${out.costUsd.toFixed(7)})`);
  }
  console.log(`\nรวมค่าใช้จ่ายของ ${model}: $${total.toFixed(6)}\n`);
}
