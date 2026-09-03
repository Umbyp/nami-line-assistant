import { DateTime } from 'luxon';
import { env } from '../config/env.js';

export const BKK = 'Asia/Bangkok';

/**
 * ─────────────────────────────────────────────────────────────
 * กฎการจัดการเวลาของนามิ
 *   1. DB เก็บ UTC เสมอ (timestamptz)
 *   2. การคำนวณ "วัน/เวลา" ทั้งหมดทำบน tz ของผู้ใช้ (ดีฟอลต์ Asia/Bangkok)
 *   3. ห้ามใช้ new Date() ในการคำนวณวันที่ ให้ผ่าน luxon + zone เสมอ
 *      เพราะเซิร์ฟเวอร์อาจรันบน TZ อะไรก็ได้
 * ─────────────────────────────────────────────────────────────
 */

export function nowUtc(): Date {
  return new Date();
}

export function inZone(d: Date, tz: string = env.APP_TIMEZONE): DateTime {
  return DateTime.fromJSDate(d, { zone: tz });
}

/** นาทีนับจากเที่ยงคืนของ local time (0-1439) */
export function minuteOfDay(d: Date, tz: string = env.APP_TIMEZONE): number {
  const local = inZone(d, tz);
  return local.hour * 60 + local.minute;
}

/** 'YYYY-MM' ตามเวลาไทย — ใช้เป็น key ของ usage_counters */
export function monthKey(d: Date = nowUtc(), tz: string = env.APP_TIMEZONE): string {
  return inZone(d, tz).toFormat('yyyy-MM');
}

const THAI_MONTHS_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
];

const THAI_DOW_SHORT = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.', 'อา.']; // luxon: 1=จันทร์ ... 7=อาทิตย์

export const THAI_DOW_FULL = [
  'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์',
];

/** "อา. 14 ก.ย. 18:00" — ไม่ใส่ปีถ้าเป็นปีเดียวกับปัจจุบัน */
export function formatThaiDateTime(
  d: Date,
  tz: string = env.APP_TIMEZONE,
  now: Date = nowUtc(),
): string {
  const local = inZone(d, tz);
  const dow = THAI_DOW_SHORT[local.weekday - 1] ?? '';
  const mon = THAI_MONTHS_SHORT[local.month - 1] ?? '';
  const time = local.toFormat('HH:mm');
  const sameYear = local.year === inZone(now, tz).year;
  // ปีไทย = ค.ศ. + 543
  const yearPart = sameYear ? '' : ` ${local.year + 543}`;
  return `${dow} ${local.day} ${mon}${yearPart} ${time}`;
}

/** "วันนี้ 18:00" / "พรุ่งนี้ 08:30" / "อา. 14 ก.ย. 18:00" */
export function formatThaiFriendly(
  d: Date,
  tz: string = env.APP_TIMEZONE,
  now: Date = nowUtc(),
): string {
  const local = inZone(d, tz);
  const today = inZone(now, tz).startOf('day');
  const diffDays = Math.round(local.startOf('day').diff(today, 'days').days);
  const time = local.toFormat('HH:mm');
  if (diffDays === 0) return `วันนี้ ${time}`;
  if (diffDays === 1) return `พรุ่งนี้ ${time}`;
  if (diffDays === 2) return `มะรืนนี้ ${time}`;
  if (diffDays === -1) return `เมื่อวาน ${time}`;
  return formatThaiDateTime(d, tz, now);
}

/** 1320 → "22:00" */
export function formatMinuteOfDay(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * ตั้งเวลาของวันหนึ่งเป็น "นาทีที่ N จากเที่ยงคืน" แบบยึดหน้าปัดนาฬิกา
 *
 * ห้ามใช้ startOf('day').plus({ minutes }) เพราะ plus บวก "ระยะเวลาจริง"
 * วันที่มี DST มี 23 หรือ 25 ชั่วโมง ทำให้ผลลัพธ์เพี้ยนไป 1 ชั่วโมง
 *   ตัวอย่างจริง: 1 พ.ย. 2026 ที่นิวยอร์ก (วันเลื่อนนาฬิกาถอยหลัง)
 *   00:00 + 480 นาที = 07:00 ไม่ใช่ 08:00
 * set() ยึดหน้าปัด จึงได้ 08:00 เสมอไม่ว่า offset จะขยับไปทางไหน
 *
 * รองรับนาทีเกิน 1440 (เที่ยงคืนของวันถัดไป) ด้วยการบวกวันแบบปฏิทินก่อน
 */
export function atLocalMinute(localDay: DateTime, minute: number): DateTime {
  const days = Math.floor(minute / 1440);
  const m = ((minute % 1440) + 1440) % 1440;
  return localDay
    .startOf('day')
    .plus({ days })
    .set({ hour: Math.floor(m / 60), minute: m % 60, second: 0, millisecond: 0 });
}

/**
 * อยู่ในช่วงเวลาเงียบหรือไม่
 * รองรับช่วงที่ข้ามเที่ยงคืน เช่น start=1320 (22:00) end=420 (07:00)
 * ช่วงเป็นแบบ [start, end) — ถึงเวลา end แล้วถือว่าออกจากช่วงเงียบ
 */
export function isInQuietHours(
  minuteOfDayLocal: number,
  start: number | null | undefined,
  end: number | null | undefined,
): boolean {
  if (start == null || end == null) return false;
  if (start === end) return false; // ช่วงว่าง = ไม่มี quiet hours
  if (start < end) return minuteOfDayLocal >= start && minuteOfDayLocal < end;
  // ข้ามเที่ยงคืน
  return minuteOfDayLocal >= start || minuteOfDayLocal < end;
}

/**
 * เลื่อนเวลาที่ตกในช่วงเงียบไปเป็น "เวลาสิ้นสุดช่วงเงียบ" ของรอบที่ใกล้ที่สุด
 * ใช้กับการเตือนแบบ recurring ตามสเปก
 * ถ้าไม่ได้อยู่ในช่วงเงียบ → คืนค่าเดิม
 */
export function shiftOutOfQuietHours(
  fireAtUtc: Date,
  start: number | null | undefined,
  end: number | null | undefined,
  tz: string = env.APP_TIMEZONE,
): Date {
  if (!isInQuietHours(minuteOfDay(fireAtUtc, tz), start, end)) return fireAtUtc;
  const local = inZone(fireAtUtc, tz);
  const mod = local.hour * 60 + local.minute;
  const endMinute = end as number;
  const startMinute = start as number;

  // ถ้าช่วงเงียบข้ามเที่ยงคืน และเวลาปัจจุบันอยู่ฝั่งดึก (>= start)
  // → เวลาสิ้นสุดคือ end ของ "วันถัดไป"
  const crossesMidnight = startMinute > endMinute;
  const targetDay = crossesMidnight && mod >= startMinute ? local.plus({ days: 1 }) : local;

  return atLocalMinute(targetDay, endMinute).toUTC().toJSDate();
}

/**
 * แปลง "วันที่ local + นาทีจากเที่ยงคืน" → UTC
 * ใช้ตอนคำนวณ occurrence ถัดไปจาก rrule (rrule ให้วันมา เราใส่เวลาเอง)
 * หมายเหตุ: ถ้าเวลานั้นไม่มีอยู่จริงเพราะ DST (ไทยไม่มี แต่ผู้ใช้อาจตั้ง tz อื่น)
 * luxon จะเลื่อนไปเวลาที่ใกล้ที่สุดให้เอง
 */
export function localDayAndMinuteToUtc(
  localDay: DateTime,
  minute: number,
  tz: string = env.APP_TIMEZONE,
): Date {
  return atLocalMinute(localDay.setZone(tz), minute).toUTC().toJSDate();
}
