import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  BKK,
  formatMinuteOfDay,
  formatThaiDateTime,
  formatThaiFriendly,
  isInQuietHours,
  localDayAndMinuteToUtc,
  minuteOfDay,
  monthKey,
  shiftOutOfQuietHours,
} from '../src/lib/time.js';

/** ช่วยอ่านง่าย: เวลาไทย → Date (UTC ข้างใน) */
function bkk(iso: string): Date {
  return DateTime.fromISO(iso, { zone: BKK }).toUTC().toJSDate();
}

describe('minuteOfDay', () => {
  it('คิดตามเวลาไทย ไม่ใช่ UTC (ไทย = UTC+7)', () => {
    // 2026-09-03T18:30 ไทย = 11:30 UTC
    const d = bkk('2026-09-03T18:30');
    expect(d.toISOString()).toBe('2026-09-03T11:30:00.000Z');
    expect(minuteOfDay(d, BKK)).toBe(18 * 60 + 30);
    expect(minuteOfDay(d, 'UTC')).toBe(11 * 60 + 30);
  });

  it('เวลาไทยตี 2 = วันเดิมของไทย แต่เป็นวันก่อนหน้าใน UTC', () => {
    const d = bkk('2026-09-03T02:00');
    expect(d.toISOString()).toBe('2026-09-02T19:00:00.000Z');
    expect(minuteOfDay(d, BKK)).toBe(120);
  });
});

describe('monthKey', () => {
  it('ใช้เดือนตามเวลาไทย — วันสิ้นเดือนตอนกลางคืนต้องไม่หลุดไปเดือนก่อน', () => {
    // 1 ต.ค. 2026 ตี 3 เวลาไทย = 30 ก.ย. 20:00 UTC → key ต้องเป็น 2026-10
    const d = bkk('2026-10-01T03:00');
    expect(d.toISOString()).toBe('2026-09-30T20:00:00.000Z');
    expect(monthKey(d, BKK)).toBe('2026-10');
    expect(monthKey(d, 'UTC')).toBe('2026-09');
  });
});

describe('isInQuietHours', () => {
  it('ช่วงปกติ (ไม่ข้ามเที่ยงคืน)', () => {
    // 13:00-14:00
    expect(isInQuietHours(12 * 60 + 59, 780, 840)).toBe(false);
    expect(isInQuietHours(780, 780, 840)).toBe(true);
    expect(isInQuietHours(839, 780, 840)).toBe(true);
    expect(isInQuietHours(840, 780, 840)).toBe(false); // ปลายช่วงเป็น exclusive
  });

  it('ช่วงข้ามเที่ยงคืน 22:00-07:00', () => {
    const start = 22 * 60; // 1320
    const end = 7 * 60; // 420
    expect(isInQuietHours(21 * 60 + 59, start, end)).toBe(false);
    expect(isInQuietHours(1320, start, end)).toBe(true);
    expect(isInQuietHours(0, start, end)).toBe(true); // เที่ยงคืน
    expect(isInQuietHours(419, start, end)).toBe(true); // 06:59
    expect(isInQuietHours(420, start, end)).toBe(false); // 07:00 ตื่นแล้ว
    expect(isInQuietHours(12 * 60, start, end)).toBe(false);
  });

  it('ไม่มี quiet hours ถ้าเป็น null หรือ start = end', () => {
    expect(isInQuietHours(100, null, 420)).toBe(false);
    expect(isInQuietHours(100, 1320, null)).toBe(false);
    expect(isInQuietHours(100, 480, 480)).toBe(false);
  });
});

describe('shiftOutOfQuietHours', () => {
  const start = 1320; // 22:00
  const end = 420; // 07:00

  it('ไม่แตะเวลาที่อยู่นอกช่วงเงียบ', () => {
    const d = bkk('2026-09-03T18:00');
    expect(shiftOutOfQuietHours(d, start, end, BKK)).toEqual(d);
  });

  it('เวลา 23:30 → เลื่อนไป 07:00 ของวันถัดไป', () => {
    const d = bkk('2026-09-03T23:30');
    const out = shiftOutOfQuietHours(d, start, end, BKK);
    expect(DateTime.fromJSDate(out, { zone: BKK }).toISO({ suppressMilliseconds: true })).toBe(
      '2026-09-04T07:00:00+07:00',
    );
  });

  it('เวลา 03:00 (ยังเป็นคืนเดียวกัน) → เลื่อนไป 07:00 ของวันเดียวกัน', () => {
    const d = bkk('2026-09-04T03:00');
    const out = shiftOutOfQuietHours(d, start, end, BKK);
    expect(DateTime.fromJSDate(out, { zone: BKK }).toISO({ suppressMilliseconds: true })).toBe(
      '2026-09-04T07:00:00+07:00',
    );
  });

  it('เลื่อนแล้วต้องไม่ตกอยู่ในช่วงเงียบอีก', () => {
    for (const iso of ['2026-09-03T22:00', '2026-09-03T23:59', '2026-09-04T00:00', '2026-09-04T06:59']) {
      const out = shiftOutOfQuietHours(bkk(iso), start, end, BKK);
      expect(isInQuietHours(minuteOfDay(out, BKK), start, end)).toBe(false);
    }
  });

  it('รองรับช่วงเงียบที่ไม่ข้ามเที่ยงคืน เช่น 13:00-14:00 (พักกลางวัน)', () => {
    const d = bkk('2026-09-03T13:30');
    const out = shiftOutOfQuietHours(d, 780, 840, BKK);
    expect(DateTime.fromJSDate(out, { zone: BKK }).toISO({ suppressMilliseconds: true })).toBe(
      '2026-09-03T14:00:00+07:00',
    );
  });
});

describe('localDayAndMinuteToUtc', () => {
  it('วัน local + นาที → UTC ถูกต้อง', () => {
    const day = DateTime.fromISO('2026-09-03T00:00', { zone: BKK });
    const out = localDayAndMinuteToUtc(day, 8 * 60, BKK);
    expect(out.toISOString()).toBe('2026-09-03T01:00:00.000Z'); // 08:00 ไทย
  });

  it('เที่ยงคืนของวันถัดไป (นาที = 1440) ไม่เพี้ยน', () => {
    const day = DateTime.fromISO('2026-09-03T00:00', { zone: BKK });
    const out = localDayAndMinuteToUtc(day, 1440, BKK);
    expect(out.toISOString()).toBe('2026-09-03T17:00:00.000Z'); // 4 ก.ย. 00:00 ไทย
  });
});

describe('การแสดงผลภาษาไทย', () => {
  const now = bkk('2026-09-03T10:00'); // พฤหัสบดี

  it('formatThaiFriendly: วันนี้ / พรุ่งนี้ / มะรืนนี้', () => {
    expect(formatThaiFriendly(bkk('2026-09-03T18:00'), BKK, now)).toBe('วันนี้ 18:00');
    expect(formatThaiFriendly(bkk('2026-09-04T08:30'), BKK, now)).toBe('พรุ่งนี้ 08:30');
    expect(formatThaiFriendly(bkk('2026-09-05T08:30'), BKK, now)).toBe('มะรืนนี้ 08:30');
  });

  it('formatThaiFriendly: เกิน 2 วันใช้รูปแบบวันที่', () => {
    expect(formatThaiFriendly(bkk('2026-09-14T18:00'), BKK, now)).toBe('จ. 14 ก.ย. 18:00');
  });

  it('formatThaiDateTime: ปีต่างกันต้องมี พ.ศ.', () => {
    expect(formatThaiDateTime(bkk('2027-01-05T09:00'), BKK, now)).toBe('อ. 5 ม.ค. 2570 09:00');
  });

  it('เวลาตี 1 ของไทย ต้องแสดงเป็นวันไทย ไม่ใช่วัน UTC', () => {
    // 4 ก.ย. 01:00 ไทย = 3 ก.ย. 18:00 UTC
    expect(formatThaiFriendly(bkk('2026-09-04T01:00'), BKK, now)).toBe('พรุ่งนี้ 01:00');
  });

  it('formatMinuteOfDay', () => {
    expect(formatMinuteOfDay(0)).toBe('00:00');
    expect(formatMinuteOfDay(420)).toBe('07:00');
    expect(formatMinuteOfDay(1320)).toBe('22:00');
    expect(formatMinuteOfDay(1439)).toBe('23:59');
  });
});
