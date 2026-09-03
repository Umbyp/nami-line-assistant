/** ทดสอบซ้ำหลายรอบว่าโมเดลอ่านคำบอกเวลาแบบไทยผิดเป็นระบบหรือแค่ครั้งเดียว */
import { parseUserMessage } from '../src/nlu/parse.js';
import { env } from '../src/config/env.js';
import { DateTime } from 'luxon';

const NOW = DateTime.fromISO('2026-09-03T12:00', { zone: 'Asia/Bangkok' }).toUTC().toJSDate();
const cases = process.argv.slice(2);
const ROUNDS = 2;

for (const text of cases) {
  console.log(`\n▸ ${text}`);
  for (let i = 0; i < ROUNDS; i++) {
    const out = await parseUserMessage(text, {
      now: NOW, tz: env.APP_TIMEZONE, isGroup: false,
    });
    if (!out.ok) { console.log(`   รอบ ${i + 1}: ❌ ${out.reason}`); continue; }
    const r = out.result.reminder;
    console.log(
      `   รอบ ${i + 1}: kind=${r?.kind} due=${r?.dueAtLocal} rrule=${r?.rrule} ` +
      `every=${r?.everyMinutes} minLocal=${r?.fireAtMinuteLocal} ` +
      `title=${JSON.stringify(r?.title)} amb=[${out.result.ambiguousFields}]`,
    );
  }
}
