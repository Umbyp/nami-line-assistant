import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import {
  describeRecurrence,
  firstOccurrence,
  nextOccurrence,
} from '../src/scheduler/nextOccurrence.js';
import { BKK } from '../src/lib/time.js';

function bkk(iso: string): Date {
  return DateTime.fromISO(iso, { zone: BKK }).toUTC().toJSDate();
}
function asBkk(d: Date): string {
  return DateTime.fromJSDate(d, { zone: BKK }).toFormat('yyyy-MM-dd HH:mm ccc');
}
function inTz(d: Date, tz: string): string {
  return DateTime.fromJSDate(d, { zone: tz }).toFormat('yyyy-MM-dd HH:mm ZZ');
}

/** helper: หา n รอบถัดไปติดกัน โดยอ้างจาก canonical ของรอบก่อน (เหมือนที่ scheduler ทำจริง) */
function series(
  input: Parameters<typeof nextOccurrence>[0],
  n: number,
): string[] {
  const out: string[] = [];
  let after = input.after;
  for (let i = 0; i < n; i++) {
    const r = nextOccurrence({ ...input, after });
    if (!r.ok) {
      out.push(`FAIL:${r.reason}`);
      break;
    }
    out.push(asBkk(r.fireAtUtc));
    after = r.canonicalFireAtUtc;
  }
  return out;
}

// พฤหัสบดี 3 ก.ย. 2026 12:00 ไทย
const NOW = bkk('2026-09-03T12:00');

describe('nextOccurrence — รายวัน', () => {
  it('ทุกวัน 8 โมง', () => {
    expect(
      series({ rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480, tz: BKK, after: NOW }, 3),
    ).toEqual([
      '2026-09-04 08:00 Fri',
      '2026-09-05 08:00 Sat',
      '2026-09-06 08:00 Sun',
    ]);
  });

  it('ทุกวัน 20:00 — วันนี้ยังไม่ถึง แต่ nextOccurrence ต้องหา "หลังจาก after" เท่านั้น', () => {
    const r = nextOccurrence({
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 1200, tz: BKK, after: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(asBkk(r.fireAtUtc)).toBe('2026-09-03 20:00 Thu');
  });
});

describe('nextOccurrence — รายสัปดาห์', () => {
  it('ทุกวันจันทร์-ศุกร์ 8 โมง ต้องข้ามเสาร์อาทิตย์', () => {
    expect(
      series(
        { rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', fireAtMinuteLocal: 480, tz: BKK, after: NOW },
        4,
      ),
    ).toEqual([
      '2026-09-04 08:00 Fri',
      '2026-09-07 08:00 Mon',
      '2026-09-08 08:00 Tue',
      '2026-09-09 08:00 Wed',
    ]);
  });

  it('หลายวันแบบไม่ติดกัน (จ. พ. ศ.)', () => {
    expect(
      series({ rrule: 'FREQ=WEEKLY;BYDAY=MO,WE,FR', fireAtMinuteLocal: 1020, tz: BKK, after: NOW }, 4),
    ).toEqual([
      '2026-09-04 17:00 Fri',
      '2026-09-07 17:00 Mon',
      '2026-09-09 17:00 Wed',
      '2026-09-11 17:00 Fri',
    ]);
  });

  it('วันเดียวต่อสัปดาห์ เว้น 7 วันเสมอ', () => {
    expect(
      series({ rrule: 'FREQ=WEEKLY;BYDAY=SU', fireAtMinuteLocal: 600, tz: BKK, after: NOW }, 3),
    ).toEqual([
      '2026-09-06 10:00 Sun',
      '2026-09-13 10:00 Sun',
      '2026-09-20 10:00 Sun',
    ]);
  });
});

describe('nextOccurrence — รายเดือน (จุดที่พลาดง่ายที่สุด)', () => {
  it('ทุกวันที่ 25', () => {
    expect(
      series({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=25', fireAtMinuteLocal: 540, tz: BKK, after: NOW }, 3),
    ).toEqual([
      '2026-09-25 09:00 Fri',
      '2026-10-25 09:00 Sun',
      '2026-11-25 09:00 Wed',
    ]);
  });

  it('ทุกวันที่ 31 ต้องข้ามเดือนที่ไม่มีวันที่ 31 (ไม่ใช่เลื่อนไปวันที่ 1)', () => {
    expect(
      series({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=31', fireAtMinuteLocal: 540, tz: BKK, after: NOW }, 4),
    ).toEqual([
      '2026-10-31 09:00 Sat', // ก.ย. มี 30 วัน → ข้าม
      '2026-12-31 09:00 Thu', // พ.ย. มี 30 วัน → ข้าม
      '2027-01-31 09:00 Sun',
      '2027-03-31 09:00 Wed', // ก.พ. → ข้าม
    ]);
  });

  it('ทุกวันที่ 29 ต้องข้าม ก.พ. ของปีที่ไม่ใช่อธิกสุรทิน', () => {
    const s = series(
      {
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=29',
        fireAtMinuteLocal: 540,
        tz: BKK,
        after: bkk('2027-01-30T12:00'),
      },
      2,
    );
    // 2027 ไม่ใช่ปีอธิกสุรทิน → ก.พ. ไม่มีวันที่ 29
    expect(s[0]).toBe('2027-03-29 09:00 Mon');
  });

  it('ทุกวันที่ 29 ปีอธิกสุรทินต้องมี 29 ก.พ.', () => {
    const s = series(
      {
        rrule: 'FREQ=MONTHLY;BYMONTHDAY=29',
        fireAtMinuteLocal: 540,
        tz: BKK,
        after: bkk('2028-01-30T12:00'),
      },
      1,
    );
    expect(s[0]).toBe('2028-02-29 09:00 Tue');
  });

  it('วันที่สุดท้ายของเดือน (BYMONTHDAY=-1) ได้วันจริงของแต่ละเดือน', () => {
    expect(
      series({ rrule: 'FREQ=MONTHLY;BYMONTHDAY=-1', fireAtMinuteLocal: 1020, tz: BKK, after: NOW }, 3),
    ).toEqual([
      '2026-09-30 17:00 Wed',
      '2026-10-31 17:00 Sat',
      '2026-11-30 17:00 Mon',
    ]);
  });
});

describe('nextOccurrence — รายปี', () => {
  it('วันเกิด 14 ก.พ.', () => {
    expect(
      series(
        { rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=14', fireAtMinuteLocal: 480, tz: BKK, after: NOW },
        2,
      ),
    ).toEqual(['2027-02-14 08:00 Sun', '2028-02-14 08:00 Mon']);
  });

  it('29 ก.พ. รายปี ต้องเจอแค่ปีอธิกสุรทิน', () => {
    expect(
      series(
        {
          rrule: 'FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=29',
          fireAtMinuteLocal: 480,
          tz: BKK,
          after: bkk('2026-03-01T12:00'),
        },
        2,
      ),
    ).toEqual(['2028-02-29 08:00 Tue', '2032-02-29 08:00 Sun']);
  });
});

describe('nextOccurrence — ทุก N นาที', () => {
  it('ทุก 30 นาที', () => {
    expect(series({ everyMinutes: 30, tz: BKK, after: NOW }, 3)).toEqual([
      '2026-09-03 12:30 Thu',
      '2026-09-03 13:00 Thu',
      '2026-09-03 13:30 Thu',
    ]);
  });

  it('ทุก 2 ชั่วโมง ข้ามเที่ยงคืนได้ถูก', () => {
    expect(series({ everyMinutes: 120, tz: BKK, after: bkk('2026-09-03T23:00') }, 2)).toEqual([
      '2026-09-04 01:00 Fri',
      '2026-09-04 03:00 Fri',
    ]);
  });
});

describe('nextOccurrence — quiet hours', () => {
  const quiet = { quietHoursStart: 1320, quietHoursEnd: 420 }; // 22:00-07:00

  it('เตือน 23:00 ตกในช่วงเงียบ → เลื่อนไป 07:00 วันถัดไป', () => {
    const r = nextOccurrence({
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 1380, tz: BKK, after: NOW, ...quiet,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(asBkk(r.fireAtUtc)).toBe('2026-09-04 07:00 Fri');
    expect(r.shiftedByQuietHours).toBe(true);
    // canonical ต้องเป็นเวลาตามตารางเดิม ไม่ใช่เวลาที่เลื่อนแล้ว
    expect(asBkk(r.canonicalFireAtUtc)).toBe('2026-09-03 23:00 Thu');
  });

  it('ตารางไม่เพี้ยนสะสม — ยิง 07:00 ทุกวัน ไม่ใช่ไล่หนีไปเรื่อยๆ', () => {
    // ถ้าคำนวณรอบถัดไปจากเวลาที่ถูกเลื่อนแล้ว ตารางจะค่อยๆ เพี้ยน
    expect(
      series({ rrule: 'FREQ=DAILY', fireAtMinuteLocal: 1380, tz: BKK, after: NOW, ...quiet }, 3),
    ).toEqual([
      '2026-09-04 07:00 Fri',
      '2026-09-05 07:00 Sat',
      '2026-09-06 07:00 Sun',
    ]);
  });

  it('เตือน 03:00 (ยังเป็นคืนเดียวกัน) → เลื่อนไป 07:00 วันเดียวกัน', () => {
    const r = nextOccurrence({
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 180, tz: BKK, after: NOW, ...quiet,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(asBkk(r.fireAtUtc)).toBe('2026-09-04 07:00 Fri');
  });

  it('เวลานอกช่วงเงียบไม่ถูกแตะ', () => {
    const r = nextOccurrence({
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480, tz: BKK, after: NOW, ...quiet,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(asBkk(r.fireAtUtc)).toBe('2026-09-04 08:00 Fri');
    expect(r.shiftedByQuietHours).toBe(false);
  });

  it('ไม่ตั้ง quiet hours → ไม่เลื่อนอะไร', () => {
    const r = nextOccurrence({
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 1380, tz: BKK, after: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(asBkk(r.fireAtUtc)).toBe('2026-09-03 23:00 Thu');
  });
});

describe('nextOccurrence — timezone ที่มี DST', () => {
  const NY = 'America/New_York';

  it('เวลาท้องถิ่นคงที่ 08:00 แม้ offset เปลี่ยนตอน spring forward', () => {
    // 8 มี.ค. 2026 เป็นวันที่นิวยอร์กเปลี่ยนเป็น EDT
    const after = DateTime.fromISO('2026-03-06T12:00', { zone: NY }).toUTC().toJSDate();
    const s: string[] = [];
    let cursor = after;
    for (let i = 0; i < 4; i++) {
      const r = nextOccurrence({ rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480, tz: NY, after: cursor });
      if (!r.ok) break;
      s.push(inTz(r.fireAtUtc, NY));
      cursor = r.canonicalFireAtUtc;
    }
    // เวลาท้องถิ่นต้องเป็น 08:00 ทุกวัน แต่ offset เปลี่ยนจาก -05:00 เป็น -04:00
    // 8 มี.ค. 2026 นาฬิกาเดินหน้าตอน 02:00 → 08:00 ของวันนั้นเป็น EDT แล้ว
    expect(s).toEqual([
      '2026-03-07 08:00 -05:00',
      '2026-03-08 08:00 -04:00',
      '2026-03-09 08:00 -04:00',
      '2026-03-10 08:00 -04:00',
    ]);
  });

  it('fall back ก็ยังคงเวลาท้องถิ่น', () => {
    const after = DateTime.fromISO('2026-10-31T12:00', { zone: NY }).toUTC().toJSDate();
    const s: string[] = [];
    let cursor = after;
    for (let i = 0; i < 3; i++) {
      const r = nextOccurrence({ rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480, tz: NY, after: cursor });
      if (!r.ok) break;
      s.push(inTz(r.fireAtUtc, NY));
      cursor = r.canonicalFireAtUtc;
    }
    // 1 พ.ย. 2026 นาฬิกาถอยหลังตอน 02:00 → 08:00 ของวันนั้นเป็น EST แล้ว
    expect(s).toEqual([
      '2026-11-01 08:00 -05:00',
      '2026-11-02 08:00 -05:00',
      '2026-11-03 08:00 -05:00',
    ]);
  });

  it('ไทยไม่มี DST — offset +07:00 คงที่ตลอดปี', () => {
    const r = nextOccurrence({
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480, tz: BKK, after: bkk('2026-03-07T12:00'),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(inTz(r.fireAtUtc, BKK)).toBe('2026-03-08 08:00 +07:00');
  });
});

describe('nextOccurrence — กันชนกับเวลาที่ใช้ไปแล้ว', () => {
  it('ถ้าเวลาที่คำนวณได้ถูกใช้ไปแล้ว ให้ขยับไปรอบต่อไป', () => {
    const taken = [bkk('2026-09-04T08:00')];
    const r = nextOccurrence({
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480, tz: BKK, after: NOW, taken,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(asBkk(r.fireAtUtc)).toBe('2026-09-05 08:00 Sat');
  });
});

describe('nextOccurrence — input ที่ใช้ไม่ได้', () => {
  it('ไม่มีทั้ง rrule และ everyMinutes', () => {
    const r = nextOccurrence({ tz: BKK, after: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('no_rule');
  });

  it('rrule ที่ parse ไม่ได้', () => {
    const r = nextOccurrence({ rrule: 'ไม่ใช่ rrule', fireAtMinuteLocal: 480, tz: BKK, after: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('bad_rrule');
  });
});

describe('firstOccurrence', () => {
  it('วันนี้ยังไม่ถึงเวลา → ใช้วันนี้', () => {
    const r = firstOccurrence({
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 1200, tz: BKK, now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(asBkk(r.fireAtUtc)).toBe('2026-09-03 20:00 Thu');
  });

  it('วันนี้เลยเวลาแล้ว → วันถัดไป', () => {
    const r = firstOccurrence({
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480, tz: BKK, now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(asBkk(r.fireAtUtc)).toBe('2026-09-04 08:00 Fri');
  });

  it('รายสัปดาห์ที่วันนี้ตรงวันและยังไม่ถึงเวลา → วันนี้', () => {
    // NOW เป็นวันพฤหัสบดี
    const r = firstOccurrence({
      rrule: 'FREQ=WEEKLY;BYDAY=TH', fireAtMinuteLocal: 1200, tz: BKK, now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(asBkk(r.fireAtUtc)).toBe('2026-09-03 20:00 Thu');
  });

  it('รายสัปดาห์ที่วันนี้ตรงวันแต่เลยเวลา → สัปดาห์หน้า', () => {
    const r = firstOccurrence({
      rrule: 'FREQ=WEEKLY;BYDAY=TH', fireAtMinuteLocal: 480, tz: BKK, now: NOW,
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(asBkk(r.fireAtUtc)).toBe('2026-09-10 08:00 Thu');
  });

  it('ทุก N นาที นับจากตอนนี้', () => {
    const r = firstOccurrence({ everyMinutes: 15, tz: BKK, now: NOW });
    expect(r.ok).toBe(true);
    if (r.ok) expect(asBkk(r.fireAtUtc)).toBe('2026-09-03 12:15 Thu');
  });
});

describe('describeRecurrence', () => {
  it.each([
    ['FREQ=DAILY', null, 480, 'ทุกวัน 08:00'],
    ['FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', null, 480, 'ทุกวันจันทร์-ศุกร์ 08:00'],
    ['FREQ=WEEKLY;BYDAY=MO,WE', null, 1020, 'ทุกจ. พ. 17:00'],
    ['FREQ=MONTHLY;BYMONTHDAY=25', null, 540, 'ทุกวันที่ 25 ของเดือน 09:00'],
    ['FREQ=YEARLY;BYMONTH=2;BYMONTHDAY=14', null, 480, 'ทุกปี 14 ก.พ. 08:00'],
    [null, 30, null, 'ทุก 30 นาที'],
    [null, 120, null, 'ทุก 2 ชั่วโมง'],
    [null, 2880, null, 'ทุก 2 วัน'],
  ])('%s → %s', (rrule, every, minute, expected) => {
    expect(describeRecurrence(rrule, every, minute)).toBe(expected);
  });
});
