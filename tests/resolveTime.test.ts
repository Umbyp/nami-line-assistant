import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { resolveDueAt } from '../src/nlu/resolveTime.js';
import { BKK } from '../src/lib/time.js';

/** เวลาไทย → Date */
function bkk(iso: string): Date {
  return DateTime.fromISO(iso, { zone: BKK }).toUTC().toJSDate();
}
function asBkk(d: Date): string {
  return DateTime.fromJSDate(d, { zone: BKK }).toISO({ suppressMilliseconds: true }) ?? '';
}

// พฤหัสบดี 3 ก.ย. 2026 เวลา 10:30 ไทย
const NOW = bkk('2026-09-03T10:30');

describe('resolveDueAt — เส้นทางปกติ', () => {
  it('เวลาในอนาคตวันนี้ → ไม่เลื่อน และแปลงเป็น UTC ถูก', () => {
    const out = resolveDueAt('2026-09-03T18:00', false, { now: NOW, tz: BKK });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.shiftedDays).toBe(0);
    // 18:00 ไทย = 11:00 UTC
    expect(out.dueAtUtc.toISOString()).toBe('2026-09-03T11:00:00.000Z');
  });

  it('พรุ่งนี้บ่าย 3', () => {
    const out = resolveDueAt('2026-09-04T15:00', true, { now: NOW, tz: BKK });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.dueAtUtc.toISOString()).toBe('2026-09-04T08:00:00.000Z');
  });

  it('เวลาไทยตี 2 ของวันถัดไป → UTC เป็นวันก่อนหน้า', () => {
    const out = resolveDueAt('2026-09-04T02:00', true, { now: NOW, tz: BKK });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.dueAtUtc.toISOString()).toBe('2026-09-03T19:00:00.000Z');
  });
});

describe('resolveDueAt — เวลาที่ผ่านไปแล้ว', () => {
  it('บอกแต่เวลา ไม่บอกวัน + ผ่านไปแล้ว → เลื่อนเป็นวันถัดไป', () => {
    // 08:00 ผ่านไปแล้ว (ตอนนี้ 10:30) และผู้ใช้ไม่ได้บอกวัน
    const out = resolveDueAt('2026-09-03T08:00', false, { now: NOW, tz: BKK });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.shiftedDays).toBe(1);
    expect(asBkk(out.dueAtUtc)).toBe('2026-09-04T08:00:00+07:00');
  });

  it('บอกวันชัดเจน + ผ่านไปแล้ว → ไม่เลื่อนให้เอง ต้องถามกลับ', () => {
    const out = resolveDueAt('2026-09-03T08:00', true, { now: NOW, tz: BKK });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('past_explicit_date');
  });

  it('เลื่อนข้ามสิ้นเดือนได้ถูก', () => {
    const endOfMonth = bkk('2026-09-30T23:00');
    const out = resolveDueAt('2026-09-30T22:00', false, { now: endOfMonth, tz: BKK });
    expect(out.ok).toBe(true);
    if (out.ok) expect(asBkk(out.dueAtUtc)).toBe('2026-10-01T22:00:00+07:00');
  });

  it('เลื่อนข้ามปีได้ถูก', () => {
    const newYearsEve = bkk('2026-12-31T23:30');
    const out = resolveDueAt('2026-12-31T09:00', false, { now: newYearsEve, tz: BKK });
    expect(out.ok).toBe(true);
    if (out.ok) expect(asBkk(out.dueAtUtc)).toBe('2027-01-01T09:00:00+07:00');
  });

  it('ผ่านมาไม่ถึงนาที ยังถือว่าใช้ได้ (job อาจค้างคิวสักครู่)', () => {
    const out = resolveDueAt('2026-09-03T10:30', false, {
      now: new Date(NOW.getTime() + 30_000),
      tz: BKK,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.shiftedDays).toBe(0);
  });

  it('ผ่านมาเกิน grace แล้ว → เลื่อน', () => {
    const out = resolveDueAt('2026-09-03T10:30', false, {
      now: new Date(NOW.getTime() + 5 * 60_000),
      tz: BKK,
    });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.shiftedDays).toBe(1);
  });
});

describe('resolveDueAt — รูปแบบที่โมเดลส่งมาจริง', () => {
  // โมเดลเติมวินาทีมาให้เองแม้สั่งว่าเอาแค่นาที — ต้องรับได้ ไม่ใช่ปฏิเสธทั้งคำขอ
  // (บั๊กนี้เจอตอนทดสอบ end-to-end ไม่ใช่ตอน unit test)
  it('มีวินาทีติดมา → รับได้ และตัดวินาทีทิ้ง', () => {
    const out = resolveDueAt('2026-09-03T18:00:00', true, { now: NOW, tz: BKK });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.dueAtUtc.toISOString()).toBe('2026-09-03T11:00:00.000Z');
  });

  it('วินาทีที่ไม่ใช่ 00 ก็ถูกตัดลงเป็นนาที', () => {
    const out = resolveDueAt('2026-09-03T18:00:45', true, { now: NOW, tz: BKK });
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.dueAtUtc.toISOString()).toBe('2026-09-03T11:00:00.000Z');
  });
});

describe('resolveDueAt — input ที่ใช้ไม่ได้', () => {
  it('ไม่มีเวลามาเลย', () => {
    const out = resolveDueAt(null, false, { now: NOW, tz: BKK });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('missing');
  });

  it.each([
    ['2026-09-03 18:00', 'ใช้ช่องว่างแทน T'],
    ['2026-09-03T18:00+07:00', 'มี offset'],
    ['03/09/2026 18:00', 'รูปแบบไทย'],
    ['2569-09-03T18:00', 'ปี พ.ศ.'],
    ['', 'ว่าง'],
  ])('รูปแบบผิด: %s (%s)', (bad) => {
    const out = resolveDueAt(bad, false, { now: NOW, tz: BKK });
    expect(out.ok).toBe(false);
  });

  it('วันที่ไม่มีอยู่จริง: 31 กันยายน', () => {
    const out = resolveDueAt('2026-09-31T10:00', true, { now: NOW, tz: BKK });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('bad_format');
  });

  it('วันที่ไม่มีอยู่จริง: 29 ก.พ. ปีที่ไม่ใช่อธิกสุรทิน', () => {
    const out = resolveDueAt('2027-02-29T10:00', true, { now: NOW, tz: BKK });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('bad_format');
  });

  it('29 ก.พ. ปีอธิกสุรทิน ใช้ได้', () => {
    const out = resolveDueAt('2028-02-29T10:00', true, { now: NOW, tz: BKK });
    expect(out.ok).toBe(true);
  });

  it('ไกลเกิน 5 ปี → too_far (มักเกิดจากแปลง พ.ศ. เป็น ค.ศ. พลาด)', () => {
    // โมเดลลืมลบ 543 แล้วส่งปี 2569 มาเป็น ค.ศ.
    const out = resolveDueAt('2569-09-03T18:00', true, { now: NOW, tz: BKK });
    expect(out.ok).toBe(false);
    if (!out.ok) expect(['too_far', 'bad_format']).toContain(out.reason);
  });
});

describe('resolveDueAt — timezone อื่นที่มี DST', () => {
  // ไทยไม่มี DST แต่ user.tz รองรับค่าอื่นได้ ต้องไม่ระเบิด
  const NY = 'America/New_York';

  it('เวลาที่ไม่มีอยู่จริงเพราะ spring forward → ยังคืน Date ที่ใช้ได้', () => {
    // 8 มี.ค. 2026 เวลา 02:30 ไม่มีอยู่จริงที่นิวยอร์ก (ข้ามจาก 02:00 ไป 03:00)
    const nowNy = DateTime.fromISO('2026-03-01T10:00', { zone: NY }).toUTC().toJSDate();
    const out = resolveDueAt('2026-03-08T02:30', true, { now: nowNy, tz: NY });
    expect(out.ok).toBe(true);
    if (out.ok) expect(Number.isNaN(out.dueAtUtc.getTime())).toBe(false);
  });

  it('ช่วง fall back (เวลาซ้ำ) ยังคืน Date ที่ใช้ได้', () => {
    const nowNy = DateTime.fromISO('2026-11-01T00:00', { zone: NY }).toUTC().toJSDate();
    const out = resolveDueAt('2026-11-01T01:30', true, { now: nowNy, tz: NY });
    expect(out.ok).toBe(true);
    if (out.ok) expect(Number.isNaN(out.dueAtUtc.getTime())).toBe(false);
  });
});
