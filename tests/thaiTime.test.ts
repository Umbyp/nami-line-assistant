import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  extractClockMinute,
  extractWeekday,
  hasExplicitCalendarDate,
  hasRelativeDayWord,
  looksRecurring,
  nextWeekday,
  verifyDueAt,
} from '../src/nlu/thaiTime.js';
import { BKK } from '../src/lib/time.js';

function bkk(iso: string): Date {
  return DateTime.fromISO(iso, { zone: BKK }).toUTC().toJSDate();
}
function asBkk(d: Date): string {
  return DateTime.fromJSDate(d, { zone: BKK }).toFormat('yyyy-MM-dd HH:mm ccc');
}

// พฤหัสบดี 3 ก.ย. 2026 เวลา 12:00 ไทย
const NOW = bkk('2026-09-03T12:00');

describe('extractClockMinute — รูปแบบตัวเลข', () => {
  it.each([
    ['เตือน 18.00', 18 * 60],
    ['เตือน 18:30', 18 * 60 + 30],
    ['เตือน 7.05 น.', 7 * 60 + 5],
    ['เตือน 09.30 น. ไปหาหมอ', 9 * 60 + 30],
    ['เตือน 20 นาฬิกา', 20 * 60],
    ['เตือน 00.00', 0],
    ['เตือน 23.59', 23 * 60 + 59],
  ])('%s → %i', (text, minute) => {
    expect(extractClockMinute(text)?.minute).toBe(minute);
  });

  it('ไม่จับเลขที่ไม่ใช่เวลา', () => {
    expect(extractClockMinute('ซื้อของ 3.5 กิโล')).toBeNull();
    expect(extractClockMinute('จ่ายเงิน 1,500 บาท')).toBeNull();
    expect(extractClockMinute('เตือน 25.00')).toBeNull();
    expect(extractClockMinute('เตือน 12.75')).toBeNull();
  });
});

describe('extractClockMinute — คำบอกเวลาแบบไทย', () => {
  it.each([
    ['ตี 1', 60],
    ['ตี 2 ครึ่ง', 2 * 60 + 30],
    ['ตี ห้า', 5 * 60],
    ['6 โมงเช้า', 6 * 60],
    ['8 โมงเช้าครึ่ง', 8 * 60 + 30],
    ['เที่ยง', 12 * 60],
    ['เที่ยงวัน', 12 * 60],
    ['เที่ยงคืน', 0],
    ['บ่ายโมง', 13 * 60],
    ['บ่ายโมงครึ่ง', 13 * 60 + 30],
    ['บ่าย 2', 14 * 60],
    ['บ่าย 3', 15 * 60],
    ['บ่ายสาม', 15 * 60],
    ['บ่าย 2 ครึ่ง', 14 * 60 + 30],
    ['4 โมงเย็น', 16 * 60],
    ['5 โมงเย็น', 17 * 60],
    ['ห้าโมงเย็น', 17 * 60],
    ['6 โมงเย็น', 18 * 60],
    ['1 ทุ่ม', 19 * 60],
    ['2 ทุ่ม', 20 * 60],
    ['สองทุ่ม', 20 * 60],
    ['3 ทุ่มครึ่ง', 21 * 60 + 30],
    ['4 ทุ่ม', 22 * 60],
    ['ทุ่มครึ่ง', 19 * 60 + 30],
    ['9 โมง', 9 * 60],
    ['11 โมง', 11 * 60],
  ])('%s → %i', (text, minute) => {
    expect(extractClockMinute(`เตือน${text}`)?.minute).toBe(minute);
  });

  it('เลขไทย ๐-๙ ก็อ่านได้', () => {
    expect(extractClockMinute('เตือน ๒ ทุ่ม')?.minute).toBe(20 * 60);
  });

  it('"N โมง" เปล่าๆ ที่กำกวม (1-6) ไม่เดา', () => {
    expect(extractClockMinute('เตือน 3 โมง')).toBeNull();
    expect(extractClockMinute('เตือน 5 โมง')).toBeNull();
  });

  it('ไม่มีคำบอกเวลาเลย → null', () => {
    expect(extractClockMinute('เตือนซื้อนม')).toBeNull();
    expect(extractClockMinute('เตือนตอนเย็นๆ นะ')).toBeNull();
  });

  it('เจอหลายเวลาที่ขัดกัน → null (ไม่เดา ปล่อยให้โมเดลตัดสิน)', () => {
    expect(extractClockMinute('ประชุม 09.00 ถึง 17.00')).toBeNull();
    expect(extractClockMinute('เตือน 2 ทุ่ม หรือ บ่าย 3')).toBeNull();
  });

  it('เจอเวลาเดียวกันเขียนสองแบบ → ยังใช้ได้', () => {
    expect(extractClockMinute('เตือน 2 ทุ่ม (20.00)')?.minute).toBe(20 * 60);
  });
});

describe('extractWeekday', () => {
  it.each([
    ['วันจันทร์', 1, 'bare'],
    ['วันอังคาร', 2, 'bare'],
    ['วันพุธ', 3, 'bare'],
    ['วันพฤหัสบดี', 4, 'bare'],
    ['วันศุกร์', 5, 'bare'],
    ['วันเสาร์', 6, 'bare'],
    ['วันอาทิตย์', 7, 'bare'],
    ['วันศุกร์นี้', 5, 'this'],
    ['วันศุกร์หน้า', 5, 'next'],
  ])('%s → weekday %i mode %s', (text, weekday, mode) => {
    const out = extractWeekday(`เตือน${text} 2 ทุ่ม`);
    expect(out?.weekday).toBe(weekday);
    expect(out?.mode).toBe(mode);
  });

  it('ระบุหลายวัน (จันทร์-ศุกร์) → null เพราะเป็นการเตือนซ้ำ', () => {
    expect(extractWeekday('ทุกวันจันทร์-ศุกร์ 8 โมง')).toBeNull();
  });

  it('ไม่มีชื่อวัน → null', () => {
    expect(extractWeekday('เตือนพรุ่งนี้ 2 ทุ่ม')).toBeNull();
  });
});

describe('nextWeekday', () => {
  // พฤหัสบดี 3 ก.ย. 2026 12:00
  const now = DateTime.fromISO('2026-09-03T12:00', { zone: BKK });

  it('วันศุกร์ (พรุ่งนี้) → 4 ก.ย.', () => {
    expect(nextWeekday(now, 5, 'bare', 20 * 60).toFormat('yyyy-MM-dd')).toBe('2026-09-04');
  });

  it('วันจันทร์ (สัปดาห์หน้า เพราะจันทร์นี้ผ่านไปแล้ว) → 7 ก.ย.', () => {
    expect(nextWeekday(now, 1, 'bare', 8 * 60).toFormat('yyyy-MM-dd')).toBe('2026-09-07');
  });

  it('วันพฤหัส = วันนี้ และเวลายังไม่ถึง → วันนี้', () => {
    expect(nextWeekday(now, 4, 'bare', 20 * 60).toFormat('yyyy-MM-dd')).toBe('2026-09-03');
  });

  it('วันพฤหัส = วันนี้ แต่เวลาผ่านไปแล้ว → สัปดาห์หน้า', () => {
    expect(nextWeekday(now, 4, 'bare', 8 * 60).toFormat('yyyy-MM-dd')).toBe('2026-09-10');
  });

  it('"วันศุกร์หน้า" = ศุกร์ของสัปดาห์ถัดไป (11 ก.ย.) ไม่ใช่ศุกร์ที่ใกล้สุด', () => {
    expect(nextWeekday(now, 5, 'next', 20 * 60).toFormat('yyyy-MM-dd')).toBe('2026-09-11');
  });
});

describe('verifyDueAt — เคสที่โมเดลพลาดจริง', () => {
  it('"วันศุกร์ 2 ทุ่ม": โมเดลให้ เสาร์ 19:00 → แก้เป็น ศุกร์ 20:00', () => {
    const out = verifyDueAt({
      text: 'เตือนวันศุกร์ 2 ทุ่ม ดูหนังกับแฟน',
      dueAtUtc: bkk('2026-09-05T19:00'), // ผลผิดที่โมเดลให้มาจริง
      now: NOW,
      tz: BKK,
    });
    expect(asBkk(out.dueAtUtc)).toBe('2026-09-04 20:00 Fri');
    expect(out.corrections).toHaveLength(2);
    expect(out.corrections.join(' ')).toContain('2 ทุ่ม');
  });

  it('โมเดลทำถูกอยู่แล้ว → ไม่แก้ ไม่มี corrections', () => {
    const out = verifyDueAt({
      text: 'เตือน 3 ทุ่มครึ่ง อ่านหนังสือ',
      dueAtUtc: bkk('2026-09-03T21:30'),
      now: NOW,
      tz: BKK,
    });
    expect(asBkk(out.dueAtUtc)).toBe('2026-09-03 21:30 Thu');
    expect(out.corrections).toEqual([]);
  });

  it('"วันจันทร์ 5 โมงเย็น" ที่โมเดลทำถูก → ไม่แตะ', () => {
    const out = verifyDueAt({
      text: 'เตือนวันจันทร์ 5 โมงเย็น ส่งของ',
      dueAtUtc: bkk('2026-09-07T17:00'),
      now: NOW,
      tz: BKK,
    });
    expect(asBkk(out.dueAtUtc)).toBe('2026-09-07 17:00 Mon');
    expect(out.corrections).toEqual([]);
  });

  it('แก้เฉพาะเวลาเมื่อวันถูกแล้ว', () => {
    const out = verifyDueAt({
      text: 'เตือนพรุ่งนี้บ่าย 3 ประชุม',
      dueAtUtc: bkk('2026-09-04T14:00'), // โมเดลให้ 14:00 แต่ควรเป็น 15:00
      now: NOW,
      tz: BKK,
    });
    expect(asBkk(out.dueAtUtc)).toBe('2026-09-04 15:00 Fri');
    expect(out.corrections).toHaveLength(1);
  });

  it('มีวันที่ปฏิทินระบุชัด → ไม่แตะวัน แม้จะมีชื่อวันปนอยู่', () => {
    const out = verifyDueAt({
      text: 'เตือนวันศุกร์ที่ 25 ก.ย. 18.00 ประชุม',
      dueAtUtc: bkk('2026-09-25T18:00'),
      now: NOW,
      tz: BKK,
    });
    expect(asBkk(out.dueAtUtc)).toBe('2026-09-25 18:00 Fri');
    expect(out.corrections).toEqual([]);
  });

  it('มีคำสัมพัทธ์ (พรุ่งนี้) → เชื่อโมเดลเรื่องวัน', () => {
    const out = verifyDueAt({
      text: 'เตือนพรุ่งนี้ 2 ทุ่ม',
      dueAtUtc: bkk('2026-09-04T20:00'),
      now: NOW,
      tz: BKK,
    });
    expect(asBkk(out.dueAtUtc)).toBe('2026-09-04 20:00 Fri');
    expect(out.corrections).toEqual([]);
  });

  it('ไม่มีคำบอกเวลาชัดเจน → ไม่แตะ (เช่น "อีก 2 ชั่วโมง")', () => {
    const out = verifyDueAt({
      text: 'อีก 2 ชั่วโมงเตือนโทรกลับลูกค้า',
      dueAtUtc: bkk('2026-09-03T14:00'),
      now: NOW,
      tz: BKK,
    });
    expect(asBkk(out.dueAtUtc)).toBe('2026-09-03 14:00 Thu');
    expect(out.corrections).toEqual([]);
  });

  it('แก้แล้วกลายเป็นอดีต → เลื่อนไปรอบถัดไป', () => {
    // ตอนนี้ 12:00 พฤหัส · ผู้ใช้บอก "9 โมง" ซึ่งผ่านไปแล้ว
    const out = verifyDueAt({
      text: 'เตือน 9 โมง กินยา',
      dueAtUtc: bkk('2026-09-03T18:00'), // โมเดลให้เวลาผิด
      now: NOW,
      tz: BKK,
    });
    expect(asBkk(out.dueAtUtc)).toBe('2026-09-04 09:00 Fri');
    expect(out.corrections.join(' ')).toContain('ผ่านไปแล้ว');
  });
});

describe('looksRecurring', () => {
  // โมเดลตีความ "วันจันทร์ 5 โมงเย็น" เป็น FREQ=WEEKLY;BYDAY=MO ซ้ำทั้ง 3 รอบ
  // ซึ่งผิดตามภาษาไทย — ต้องมีคำว่า "ทุก" เท่านั้นจึงเป็นการเตือนซ้ำ
  it.each([
    'ทุกวันจันทร์ 8 โมง',
    'ทุกวัน 7 โมงเช้า',
    'ทุกวันที่ 25 จ่ายบัตร',
    'ทุก 30 นาที',
    'เตือนประจำทุกเดือน',
    'จันทร์-ศุกร์ 8 โมง',
    'เตือนซ้ำทุกปี',
  ])('ซ้ำ: %s', (t) => expect(looksRecurring(t)).toBe(true));

  it.each([
    'เตือนวันจันทร์ 5 โมงเย็น ส่งของ',
    'เตือนวันศุกร์ 2 ทุ่ม ดูหนัง',
    'พรุ่งนี้บ่าย 3 ประชุม',
    'เตือนกินยา 18.00',
    'เตือน 25 ก.ย. 09.00 ประชุม',
  ])('ครั้งเดียว: %s', (t) => expect(looksRecurring(t)).toBe(false));
});

describe('ตัวช่วยตรวจบริบท', () => {
  it('hasExplicitCalendarDate', () => {
    expect(hasExplicitCalendarDate('25 ก.ย.')).toBe(true);
    expect(hasExplicitCalendarDate('3 มีนาคม')).toBe(true);
    expect(hasExplicitCalendarDate('25/9')).toBe(true);
    expect(hasExplicitCalendarDate('วันศุกร์ 2 ทุ่ม')).toBe(false);
  });

  it('hasRelativeDayWord', () => {
    expect(hasRelativeDayWord('พรุ่งนี้')).toBe(true);
    expect(hasRelativeDayWord('มะรืนนี้')).toBe(true);
    expect(hasRelativeDayWord('อีก 2 ชั่วโมง')).toBe(true);
    expect(hasRelativeDayWord('วันศุกร์')).toBe(false);
  });
});
