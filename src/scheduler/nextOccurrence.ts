import { DateTime } from 'luxon';
// rrule 2.x เป็น CJS และไม่มี exports map → named import พังบน Node ESM
// (vitest transpile ให้ผ่าน แต่ node จริงจะ throw "does not provide an export named 'RRule'")
// default import คือ module.exports ทั้งก้อน แตกเอาเองปลอดภัยที่สุด
import rrulePkg from 'rrule';

const { RRule } = rrulePkg;
type RRuleInstance = InstanceType<typeof RRule>;
import { env } from '../config/env.js';
import { atLocalMinute, shiftOutOfQuietHours } from '../lib/time.js';

/**
 * ─────────────────────────────────────────────────────────────
 * คำนวณ "รอบถัดไป" ของการเตือนซ้ำ
 *
 * ปัญหาหลัก: rrule library ทำงานบนเวลา UTC หรือ floating time
 * แต่การเตือนของเราผูกกับ "เวลาท้องถิ่นของผู้ใช้" เช่น 8 โมงเช้าเวลาไทย
 * ถ้าคำนวณบน UTC ตรงๆ จะเพี้ยนทันทีที่ผู้ใช้อยู่ tz ที่มี DST
 *
 * วิธีที่ใช้ (floating date trick):
 *   1. ใช้ rrule หาแค่ "วันไหน" โดยมองวันเป็น UTC midnight (ไร้ timezone)
 *   2. ได้วันแล้วค่อยแปะ fireAtMinuteLocal ในโซนของผู้ใช้
 *   3. แปลงเป็น UTC ตอนท้ายสุด
 * ทำให้ 8 โมงเช้ายังเป็น 8 โมงเช้าเสมอ ไม่ว่า DST จะขยับ offset ไปทางไหน
 * ─────────────────────────────────────────────────────────────
 */

export interface NextOccurrenceInput {
  /** RFC 5545 โดยไม่มี DTSTART เช่น FREQ=WEEKLY;BYDAY=MO,WE,FR */
  rrule?: string | null;
  /** ใช้แทน rrule กรณี "ทุก N นาที" */
  everyMinutes?: number | null;
  /** เวลาที่จะเตือนในแต่ละวัน เป็นนาทีจากเที่ยงคืน (ใช้กับ rrule) */
  fireAtMinuteLocal?: number | null;
  tz?: string;
  /** หาเวลาถัดไปที่ "มากกว่า" ค่านี้ (ปกติคือเวลาตามตารางของรอบก่อนหน้า) */
  after: Date;
  quietHoursStart?: number | null;
  quietHoursEnd?: number | null;
  /** เวลาที่ถูกใช้ไปแล้ว ถ้าคำนวณได้ตรงกันจะข้ามไปรอบต่อไป (กันชน unique constraint) */
  taken?: Date[];
}

export type NextOccurrenceResult =
  | {
      ok: true;
      /** เวลาที่จะยิงจริง (ถูกเลื่อนแล้วถ้าตกในช่วงเงียบ) */
      fireAtUtc: Date;
      /** เวลาตามตารางก่อนเลื่อน — ใช้เป็นจุดอ้างอิงของรอบถัดไป */
      canonicalFireAtUtc: Date;
      /** ถูกเลื่อนเพราะ quiet hours ไหม */
      shiftedByQuietHours: boolean;
    }
  | { ok: false; reason: 'no_rule' | 'bad_rrule' | 'exhausted' };

/** จำนวนรอบสูงสุดที่จะไล่หา เผื่อกรณีชนกับเวลาที่ใช้ไปแล้วหลายรอบ */
const MAX_STEPS = 400;

export function nextOccurrence(input: NextOccurrenceInput): NextOccurrenceResult {
  const tz = input.tz ?? env.APP_TIMEZONE;
  const taken = new Set((input.taken ?? []).map((d) => d.getTime()));

  let cursor = input.after;

  for (let step = 0; step < MAX_STEPS; step++) {
    const canonical = input.everyMinutes
      ? stepEveryMinutes(cursor, input.everyMinutes)
      : stepRrule(cursor, input, tz);

    if (canonical === null) {
      return { ok: false, reason: input.everyMinutes ? 'no_rule' : 'bad_rrule' };
    }
    if (canonical === 'no_rule') return { ok: false, reason: 'no_rule' };

    // ── quiet hours: ใช้กับการเตือนซ้ำตามสเปก ──
    const shifted = shiftOutOfQuietHours(
      canonical,
      input.quietHoursStart,
      input.quietHoursEnd,
      tz,
    );
    const wasShifted = shifted.getTime() !== canonical.getTime();

    // เวลานี้ถูกใช้ไปแล้ว (เช่นถูกเลื่อนมาชนกับรอบก่อน) → ขยับไปรอบต่อไป
    if (taken.has(shifted.getTime())) {
      cursor = canonical;
      continue;
    }

    return {
      ok: true,
      fireAtUtc: shifted,
      canonicalFireAtUtc: canonical,
      shiftedByQuietHours: wasShifted,
    };
  }

  return { ok: false, reason: 'exhausted' };
}

/** ทุก N นาที — นับต่อจาก cursor ตรงๆ ไม่เกี่ยวกับวันหรือ timezone */
function stepEveryMinutes(after: Date, everyMinutes: number): Date {
  return new Date(after.getTime() + everyMinutes * 60_000);
}

function stepRrule(
  after: Date,
  input: NextOccurrenceInput,
  tz: string,
): Date | null | 'no_rule' {
  if (!input.rrule) return 'no_rule';

  const minute = input.fireAtMinuteLocal ?? 0;

  // วันของ "after" ในโซนผู้ใช้ — เป็นจุดตั้งต้นของการไล่หา
  const afterLocal = DateTime.fromJSDate(after, { zone: tz });

  let rule: RRuleInstance;
  try {
    // DTSTART เป็น UTC midnight ของวันแรกที่เป็นไปได้
    // เราสนใจแค่ "วันไหนเข้าเงื่อนไข" ไม่สนเวลาใน rrule เลย
    rule = new RRule({
      ...RRule.parseString(input.rrule),
      dtstart: floatingDay(afterLocal.minus({ days: 1 })),
    });
  } catch {
    return null;
  }

  // ไล่หาวันที่เข้าเงื่อนไข แล้วแปะเวลาท้องถิ่น
  // ต้องไล่หลายวันได้ เพราะวันแรกที่เจออาจให้เวลาที่ยังไม่เกิน after
  let probe = floatingDay(afterLocal.minus({ days: 1 }));

  for (let i = 0; i < 800; i++) {
    const day = rule.after(probe, false);
    if (!day) return null;

    const localDay = DateTime.fromObject(
      { year: day.getUTCFullYear(), month: day.getUTCMonth() + 1, day: day.getUTCDate() },
      { zone: tz },
    );
    // atLocalMinute ยึดหน้าปัดนาฬิกา ไม่ใช่บวกระยะเวลา
    // ทำให้ "8 โมงเช้า" ยังเป็น 8 โมงเช้าในวันที่นาฬิกาถูกเลื่อนเพราะ DST
    const candidate = atLocalMinute(localDay, minute).toUTC().toJSDate();

    if (candidate.getTime() > after.getTime()) return candidate;
    probe = day;
  }
  return null;
}

/** วัน local → Date ที่เป็น UTC midnight ของวันเดียวกัน (floating date) */
function floatingDay(local: DateTime): Date {
  return new Date(Date.UTC(local.year, local.month - 1, local.day));
}

/**
 * เวลาแรกของการเตือนซ้ำ นับจาก "ตอนนี้"
 * ต่างจาก nextOccurrence ตรงที่ยอมให้ตรงกับวันนี้ได้ถ้าเวลายังไม่ผ่าน
 */
export function firstOccurrence(
  input: Omit<NextOccurrenceInput, 'after'> & { now: Date },
): NextOccurrenceResult {
  const tz = input.tz ?? env.APP_TIMEZONE;

  if (input.everyMinutes) {
    return nextOccurrence({ ...input, after: input.now });
  }

  // ให้เริ่มไล่จาก "เมื่อวานตอนเที่ยงคืน" เพื่อให้วันนี้มีสิทธิ์ถูกเลือก
  const startFrom = DateTime.fromJSDate(input.now, { zone: tz })
    .startOf('day')
    .minus({ milliseconds: 1 })
    .toUTC()
    .toJSDate();

  const first = nextOccurrence({ ...input, after: startFrom });
  if (!first.ok) return first;

  // ถ้ารอบแรกที่เจอผ่านไปแล้ว ให้หารอบถัดไป
  if (first.canonicalFireAtUtc.getTime() <= input.now.getTime()) {
    return nextOccurrence({ ...input, after: first.canonicalFireAtUtc });
  }
  return first;
}

/** เอาไว้แสดงให้ผู้ใช้ว่าเตือนซ้ำแบบไหน */
export function describeRecurrence(
  rrule: string | null | undefined,
  everyMinutes: number | null | undefined,
  fireAtMinuteLocal: number | null | undefined,
): string {
  if (everyMinutes) {
    if (everyMinutes % 1440 === 0) return `ทุก ${everyMinutes / 1440} วัน`;
    if (everyMinutes % 60 === 0) return `ทุก ${everyMinutes / 60} ชั่วโมง`;
    return `ทุก ${everyMinutes} นาที`;
  }
  if (!rrule) return 'ไม่ระบุ';

  const time =
    fireAtMinuteLocal != null
      ? ` ${String(Math.floor(fireAtMinuteLocal / 60)).padStart(2, '0')}:${String(
          fireAtMinuteLocal % 60,
        ).padStart(2, '0')}`
      : '';

  const parts = Object.fromEntries(
    rrule.split(';').map((kv) => {
      const [k, v] = kv.split('=');
      return [k?.toUpperCase() ?? '', v ?? ''];
    }),
  );

  const DOW: Record<string, string> = {
    MO: 'จ.', TU: 'อ.', WE: 'พ.', TH: 'พฤ.', FR: 'ศ.', SA: 'ส.', SU: 'อา.',
  };

  switch (parts['FREQ']) {
    case 'DAILY':
      return `ทุกวัน${time}`;
    case 'WEEKLY': {
      const days = (parts['BYDAY'] ?? '').split(',').filter(Boolean);
      if (days.length === 0) return `ทุกสัปดาห์${time}`;
      if (days.length === 5 && ['MO', 'TU', 'WE', 'TH', 'FR'].every((d) => days.includes(d))) {
        return `ทุกวันจันทร์-ศุกร์${time}`;
      }
      return `ทุก${days.map((d) => DOW[d] ?? d).join(' ')}${time}`;
    }
    case 'MONTHLY': {
      const dom = parts['BYMONTHDAY'];
      return dom ? `ทุกวันที่ ${dom} ของเดือน${time}` : `ทุกเดือน${time}`;
    }
    case 'YEARLY': {
      const mon = parts['BYMONTH'];
      const dom = parts['BYMONTHDAY'];
      const THAI_MON = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.'];
      if (mon && dom) return `ทุกปี ${dom} ${THAI_MON[Number(mon) - 1] ?? mon}${time}`;
      return `ทุกปี${time}`;
    }
    default:
      return `ทุก ${rrule}`;
  }
}
