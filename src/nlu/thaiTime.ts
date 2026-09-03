import { DateTime } from 'luxon';
import { env } from '../config/env.js';

/**
 * ─────────────────────────────────────────────────────────────
 * ตัวตรวจทานคำบอกเวลาแบบไทย — deterministic ไม่เรียก LLM
 *
 * ทำไมต้องมี: จากการวัดผลจริง โมเดลพลาดตรงส่วนที่คำนวณได้แน่นอน
 *   "วันศุกร์ 2 ทุ่ม" → ได้ เสาร์ 19:00 (ผิดทั้งวันและเวลา) ผิดซ้ำทั้ง 3 รอบ
 *   แต่ "3 ทุ่มครึ่ง" → 21:30 ถูก และ "วันจันทร์" → ถูก
 * คือพลาดแบบไม่สม่ำเสมอ ซึ่ง prompt แก้ไม่หาย
 *
 * คำบอกเวลาไทยเป็นเซตปิดและแปลงได้ตรงๆ จึงควรคำนวณเองแล้วใช้ทับผลของโมเดล
 * โมเดลยังมีประโยชน์กับส่วนที่เป็นภาษา (จับ title, แยกเจตนา) — เราแค่ไม่เชื่อเรื่องเลข
 * ─────────────────────────────────────────────────────────────
 */

/** เลขไทยเป็นตัวอักษร + เลขอารบิก + เลขไทย */
const NUM_WORDS: Record<string, number> = {
  หนึ่ง: 1, สอง: 2, สาม: 3, สี่: 4, ห้า: 5, หก: 6,
  เจ็ด: 7, แปด: 8, เก้า: 9, สิบ: 10, สิบเอ็ด: 11, สิบสอง: 12,
  เอ็ด: 1,
};
const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙';

function toNumber(token: string): number | null {
  const t = token.trim();
  if (t === '') return null;

  // เลขไทย → อารบิก
  const arabic = [...t]
    .map((ch) => {
      const i = THAI_DIGITS.indexOf(ch);
      return i >= 0 ? String(i) : ch;
    })
    .join('');

  if (/^\d{1,2}$/.test(arabic)) return Number(arabic);
  return NUM_WORDS[t] ?? null;
}

/** กลุ่มจับเลข: อารบิก / เลขไทย / คำไทย */
const N = `(\\d{1,2}|[${THAI_DIGITS}]{1,2}|${Object.keys(NUM_WORDS)
  .sort((a, b) => b.length - a.length)
  .join('|')})`;

export interface ClockMatch {
  /** นาทีนับจากเที่ยงคืน 0-1439 */
  minute: number;
  /** ข้อความส่วนที่จับได้ ใช้ log/debug */
  matched: string;
}

/**
 * ดึงเวลาที่ผู้ใช้ระบุ "ชัดเจน" ออกจากข้อความ
 *
 * คืน null เมื่อไม่ชัดเจน — ตั้งใจอนุรักษ์นิยม เพราะถ้าเดาผิดจะไปทับค่าที่โมเดลทำถูก
 * เงื่อนไข: ต้องเจอแค่รูปแบบเดียว ถ้าเจอหลายรูปแบบที่ให้คำตอบต่างกัน → null
 */
export function extractClockMinute(text: string): ClockMatch | null {
  const found: ClockMatch[] = [];
  const push = (minute: number, matched: string): void => {
    if (minute >= 0 && minute <= 1439) found.push({ minute, matched });
  };

  const half = (s: string): boolean => /ครึ่ง/.test(s);

  // ── เที่ยง / เที่ยงคืน (ต้องเช็คก่อน เพราะมีคำว่า "เที่ยง" ซ้อน) ──
  if (/เที่ยงคืน/.test(text)) push(0, 'เที่ยงคืน');
  else if (/เที่ยง(วัน|ตรง)?/.test(text)) push(12 * 60, 'เที่ยง');

  // ── HH.MM / HH:MM (นาทีต้องเป็น 2 หลัก กัน "3.5" ที่ไม่ใช่เวลา) ──
  for (const m of text.matchAll(/(\d{1,2})[.:](\d{2})\s*(?:น\.?|นาฬิกา)?/g)) {
    const h = Number(m[1]);
    const mi = Number(m[2]);
    if (h <= 23 && mi <= 59) push(h * 60 + mi, m[0].trim());
  }

  // ── N นาฬิกา (ระบบ 24 ชม.) ──
  for (const m of text.matchAll(new RegExp(`${N}\\s*นาฬิกา`, 'g'))) {
    const h = toNumber(m[1] ?? '');
    if (h !== null && h <= 23) push(h * 60 + (half(m[0]) ? 30 : 0), m[0].trim());
  }

  // ── ตี N (01:00-05:00) ──
  for (const m of text.matchAll(new RegExp(`ตี\\s*${N}(\\s*ครึ่ง)?`, 'g'))) {
    const h = toNumber(m[1] ?? '');
    if (h !== null && h >= 1 && h <= 5) push(h * 60 + (half(m[0]) ? 30 : 0), m[0].trim());
  }

  // ── N ทุ่ม (19:00-24:00) — N ทุ่ม = 18 + N ──
  let sawNumberedThum = false;
  for (const m of text.matchAll(new RegExp(`${N}\\s*ทุ่ม(\\s*ครึ่ง)?`, 'g'))) {
    const n = toNumber(m[1] ?? '');
    if (n !== null && n >= 1 && n <= 6) {
      sawNumberedThum = true;
      push((18 + n) * 60 + (half(m[0]) ? 30 : 0), m[0].trim());
    }
  }
  // "ทุ่มครึ่ง" / "ทุ่มนึง" โดยไม่มีเลขนำ = 1 ทุ่ม
  // ต้องเช็คหลังแบบมีเลขนำ และข้ามถ้าเจอไปแล้ว
  // ไม่งั้น "3 ทุ่มครึ่ง" จะเข้าทั้งสองแบบแล้วได้ 21:30 กับ 19:30 → ถือว่ากำกวมทั้งที่ไม่กำกวม
  if (!sawNumberedThum && /ทุ่ม(ครึ่ง|นึง|หนึ่ง)/.test(text)) {
    push(19 * 60 + (/ทุ่มครึ่ง/.test(text) ? 30 : 0), 'ทุ่ม');
  }

  // ── บ่าย ──
  if (/บ่ายโมง/.test(text)) push(13 * 60 + (/บ่ายโมงครึ่ง/.test(text) ? 30 : 0), 'บ่ายโมง');
  for (const m of text.matchAll(new RegExp(`บ่าย\\s*${N}(\\s*โมง)?(\\s*ครึ่ง)?`, 'g'))) {
    const n = toNumber(m[1] ?? '');
    if (n !== null && n >= 1 && n <= 5) push((12 + n) * 60 + (half(m[0]) ? 30 : 0), m[0].trim());
  }

  // ── N โมงเย็น (16:00-18:00 โดยทั่วไป N = 4-6, แต่ 1-6 ก็พบ) ──
  for (const m of text.matchAll(new RegExp(`${N}\\s*โมงเย็น(\\s*ครึ่ง)?`, 'g'))) {
    const n = toNumber(m[1] ?? '');
    if (n !== null && n >= 1 && n <= 6) push((12 + n) * 60 + (half(m[0]) ? 30 : 0), m[0].trim());
  }

  // ── N โมงเช้า (06:00-11:00) ──
  for (const m of text.matchAll(new RegExp(`${N}\\s*โมงเช้า(\\s*ครึ่ง)?`, 'g'))) {
    const n = toNumber(m[1] ?? '');
    if (n !== null && n >= 6 && n <= 11) push(n * 60 + (half(m[0]) ? 30 : 0), m[0].trim());
  }

  // ── "N โมง" เปล่าๆ ── กำกวมระหว่างเช้า/เย็น จึงไม่เดา
  // ยกเว้น 7-11 ที่ในทางปฏิบัติหมายถึงเช้าแน่นอน
  for (const m of text.matchAll(new RegExp(`(?<!บ่าย\\s*)${N}\\s*โมง(?!เย็น|เช้า)(\\s*ครึ่ง)?`, 'g'))) {
    const n = toNumber(m[1] ?? '');
    if (n !== null && n >= 7 && n <= 11) push(n * 60 + (half(m[0]) ? 30 : 0), m[0].trim());
  }

  if (found.length === 0) return null;

  // เจอหลายค่าที่ไม่ตรงกัน → ไม่ชัดเจน อย่าไปทับผลของโมเดล
  const distinct = new Set(found.map((f) => f.minute));
  if (distinct.size > 1) return null;

  return found[0] ?? null;
}

/** ชื่อวันแบบไม่ต้องมี "วัน" นำ — ใช้ "นับ" ว่าข้อความพูดถึงกี่วัน */
const WEEKDAY_BARE: Array<{ re: RegExp; weekday: number }> = [
  { re: /จันทร์/, weekday: 1 },
  { re: /อังคาร/, weekday: 2 },
  { re: /พุธ/, weekday: 3 },
  { re: /พฤหัส(บดี)?|พฤหัส/, weekday: 4 },
  { re: /ศุกร์/, weekday: 5 },
  { re: /เสาร์/, weekday: 6 },
  { re: /อาทิตย์/, weekday: 7 },
];

/** ชื่อวันที่มี "วัน" นำ — ใช้หา mode (นี้/หน้า) จากคำที่ตามหลัง */
const WEEKDAY_WORDS: Array<{ re: RegExp; weekday: number }> = WEEKDAY_BARE.map(
  ({ re, weekday }) => ({ re: new RegExp(`วัน\\s*(?:${re.source})`), weekday }),
);

export interface WeekdayMatch {
  /** 1 = จันทร์ ... 7 = อาทิตย์ (ตรงกับ luxon) */
  weekday: number;
  /** bare = "วันศุกร์", this = "วันศุกร์นี้", next = "วันศุกร์หน้า" */
  mode: 'bare' | 'this' | 'next';
  matched: string;
}

export function extractWeekday(text: string): WeekdayMatch | null {
  // "ทุกวันจันทร์" = การเตือนซ้ำ ไม่ใช่ครั้งเดียว → ไม่ใช่หน้าที่ของ verifier ตัวนี้
  if (/ทุก/.test(text)) return null;

  // นับด้วยชื่อวันแบบไม่ต้องมี "วัน" นำ เพื่อจับกรณี "จันทร์-ศุกร์"
  // ที่ตัวหลังไม่มีคำว่า "วัน" — ถ้านับด้วย WEEKDAY_WORDS จะเห็นแค่วันเดียวแล้วแก้ผิด
  const mentioned = WEEKDAY_BARE.filter(({ re }) => re.test(text));
  if (mentioned.length !== 1) return null;

  const only = mentioned[0];
  if (!only) return null;

  // หา mode จากคำที่ตามหลัง โดยอ้างตำแหน่งของชื่อวันนั้น
  const m = only.re.exec(text);
  if (!m) return null;
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 6);
  const mode: WeekdayMatch['mode'] = /^\s*หน้า/.test(tail)
    ? 'next'
    : /^\s*นี้/.test(tail)
      ? 'this'
      : 'bare';

  return { weekday: only.weekday, mode, matched: m[0] };
}

/** มีวันที่แบบปฏิทินระบุมาชัดๆ ไหม เช่น "25 ก.ย." "3 มีนาคม" — ถ้ามี อย่าไปยุ่งกับวัน */
export function hasExplicitCalendarDate(text: string): boolean {
  return /\d{1,2}\s*(ม\.?ค|ก\.?พ|มี\.?ค|เม\.?ย|พ\.?ค|มิ\.?ย|ก\.?ค|ส\.?ค|ก\.?ย|ต\.?ค|พ\.?ย|ธ\.?ค)\.?|\d{1,2}\s*(มกราคม|กุมภาพันธ์|มีนาคม|เมษายน|พฤษภาคม|มิถุนายน|กรกฎาคม|สิงหาคม|กันยายน|ตุลาคม|พฤศจิกายน|ธันวาคม)|\d{1,2}\/\d{1,2}/.test(
    text,
  );
}

/**
 * ข้อความนี้บอกว่าให้เตือน "ซ้ำ" จริงไหม
 *
 * ภาษาไทยต้องมีตัวบอกความซ้ำชัดเจน:
 *   "ทุกวันจันทร์"  = ซ้ำทุกสัปดาห์
 *   "วันจันทร์"     = ครั้งเดียว (จันทร์ที่จะถึง)
 * แต่โมเดลตีความ "วันจันทร์ 5 โมงเย็น" เป็น FREQ=WEEKLY;BYDAY=MO ซ้ำทั้ง 3 รอบ
 * ทำให้ผู้ใช้ถูกปฏิเสธทั้งที่ตั้งเตือนครั้งเดียวได้ จึงต้องมีกฎนี้คุมไว้
 */
export function looksRecurring(text: string): boolean {
  // ตัวบอกความซ้ำแบบตรงๆ
  if (/ทุก|ประจำ|เป็นกิจวัตร|ซ้ำ|every/i.test(text)) return true;
  // ช่วงวัน เช่น "จันทร์-ศุกร์" "จ.-ศ." สื่อความซ้ำในตัวเอง
  const bare = WEEKDAY_BARE.filter(({ re }) => re.test(text));
  if (bare.length > 1) return true;
  // "ทุกๆ N นาที/ชั่วโมง/วัน" ที่เขียนแบบไม่มีคำว่าทุก เช่น "N นาทีครั้ง"
  if (/\d+\s*(นาที|ชั่วโมง|ชม\.?|วัน|เดือน|ปี)\s*(ครั้ง|ที)/.test(text)) return true;
  return false;
}

/** มีคำบอกวันแบบสัมพัทธ์ที่ชัดเจนอยู่แล้วไหม — ถ้ามี ให้เชื่อโมเดลเรื่องวัน */
export function hasRelativeDayWord(text: string): boolean {
  return /พรุ่งนี้|มะรืน|วันนี้|เมื่อวาน|คืนนี้|อีก\s*\d+\s*(วัน|ชั่วโมง|ชม|นาที)/.test(text);
}

export interface VerifyInput {
  /** ข้อความต้นฉบับของผู้ใช้ (หลังตัด mention/คำเรียกแล้ว) */
  text: string;
  /** เวลาที่ได้จากโมเดลแล้วผ่าน resolveDueAt มาแล้ว */
  dueAtUtc: Date;
  now?: Date;
  tz?: string;
}

export interface VerifyResult {
  dueAtUtc: Date;
  /** รายการที่ถูกแก้ ว่างแปลว่าโมเดลทำถูกทั้งหมด */
  corrections: string[];
}

/**
 * ตรวจทานเวลาที่โมเดลให้มา ด้วยกฎภาษาไทยที่คำนวณเองได้
 *
 * แก้เฉพาะเมื่อมั่นใจ:
 *   - เวลา: ผู้ใช้ระบุชัดเจน (2 ทุ่ม, 18.00, บ่าย 3) แต่โมเดลให้มาไม่ตรง → ใช้ของเรา
 *   - วัน: ผู้ใช้ระบุชื่อวันในสัปดาห์ แต่โมเดลให้วันที่ตรงกับวันอื่น → เลื่อนไปวันที่ถูก
 * นอกนั้นปล่อยผ่าน เพราะโมเดลเก่งกว่าเรื่องภาษา
 */
export function verifyDueAt(input: VerifyInput): VerifyResult {
  const tz = input.tz ?? env.APP_TIMEZONE;
  const now = input.now ?? new Date();
  const corrections: string[] = [];

  let local = DateTime.fromJSDate(input.dueAtUtc, { zone: tz });
  const nowLocal = DateTime.fromJSDate(now, { zone: tz });

  // ── 1. แก้ "วัน" ก่อน (ต้องมาก่อนเวลา เพราะการเลื่อนวันไม่กระทบเวลา) ──
  if (!hasExplicitCalendarDate(input.text) && !hasRelativeDayWord(input.text)) {
    const wd = extractWeekday(input.text);
    if (wd && local.weekday !== wd.weekday) {
      const fixed = nextWeekday(nowLocal, wd.weekday, wd.mode, local.hour * 60 + local.minute);
      corrections.push(
        `วัน: โมเดลให้ ${local.toFormat('ccc dd LLL')} แต่ "${wd.matched}" ควรเป็น ${fixed.toFormat('ccc dd LLL')}`,
      );
      local = local.set({ year: fixed.year, month: fixed.month, day: fixed.day });
    }
  }

  // ── 2. แก้ "เวลา" ──
  const clock = extractClockMinute(input.text);
  if (clock) {
    const modelMinute = local.hour * 60 + local.minute;
    if (modelMinute !== clock.minute) {
      corrections.push(
        `เวลา: โมเดลให้ ${fmt(modelMinute)} แต่ "${clock.matched}" = ${fmt(clock.minute)}`,
      );
      local = local.startOf('day').plus({ minutes: clock.minute });
    }
  }

  // ── 3. ถ้าแก้แล้วกลายเป็นอดีต ให้เลื่อนไปรอบถัดไป ──
  if (corrections.length > 0 && local.toMillis() <= nowLocal.toMillis()) {
    const wd = extractWeekday(input.text);
    local = wd ? local.plus({ weeks: 1 }) : local.plus({ days: 1 });
    corrections.push('เวลาที่แก้แล้วผ่านไปแล้ว จึงเลื่อนไปรอบถัดไป');
  }

  return { dueAtUtc: local.toUTC().toJSDate(), corrections };
}

/**
 * หาวันถัดไปที่ตรงกับวันในสัปดาห์ที่ต้องการ
 *   bare / this : วันที่ใกล้ที่สุดที่ยังมาไม่ถึง (วันนี้นับด้วยถ้าเวลายังไม่ผ่าน)
 *   next        : วันนั้นของสัปดาห์ถัดไป
 */
export function nextWeekday(
  nowLocal: DateTime,
  weekday: number,
  mode: WeekdayMatch['mode'],
  minuteOfDay: number,
): DateTime {
  const today = nowLocal.startOf('day');
  let delta = (weekday - today.weekday + 7) % 7;

  // วันนี้ตรงวันที่ขอ แต่เวลาผ่านไปแล้ว → สัปดาห์หน้า
  if (delta === 0) {
    const nowMinute = nowLocal.hour * 60 + nowLocal.minute;
    if (minuteOfDay <= nowMinute) delta = 7;
  }

  let target = today.plus({ days: delta });

  // "วันศุกร์หน้า" = ศุกร์ของสัปดาห์ถัดไป ไม่ใช่ศุกร์ที่ใกล้ที่สุด
  if (mode === 'next' && target.weekNumber === nowLocal.weekNumber) {
    target = target.plus({ weeks: 1 });
  }

  return target;
}

function fmt(minute: number): string {
  const h = Math.floor(minute / 60) % 24;
  const m = minute % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}
