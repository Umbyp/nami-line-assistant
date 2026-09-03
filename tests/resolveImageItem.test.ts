import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { resolveImageItem } from '../src/nlu/resolveImageItem.js';
import { BKK } from '../src/lib/time.js';
import type { ImageReminderItem } from '../src/nlu/imageSchema.js';

function bkk(iso: string): Date {
  return DateTime.fromISO(iso, { zone: BKK }).toUTC().toJSDate();
}
function asBkk(d: Date): string {
  return DateTime.fromJSDate(d, { zone: BKK }).toFormat('yyyy-MM-dd HH:mm');
}

const NOW = bkk('2026-09-03T10:00');

function item(over: Partial<ImageReminderItem> = {}): ImageReminderItem {
  return {
    title: 'นัดตรวจติดตามอาการ',
    kind: 'once',
    dateLocal: '2026-09-18',
    weekday: null,
    timeText: '09:30',
    confidence: 0.95,
    ...over,
  };
}

describe('resolveImageItem — once (จากใบนัด/ใบเสร็จ)', () => {
  it('แปลงวันที่ + เวลาที่อ่านจากเอกสารเป็น UTC ถูกต้อง', () => {
    const out = resolveImageItem(item(), { now: NOW, tz: BKK });
    expect(out.problem).toBeNull();
    expect(out.kind).toBe('once');
    expect(out.dueAtUtc && asBkk(out.dueAtUtc)).toBe('2026-09-18 09:30');
  });

  it('รองรับเวลาแบบไทย ("8 โมงเช้า") ผ่าน extractClockMinute ตัวเดียวกับที่ใช้กับข้อความ', () => {
    const out = resolveImageItem(item({ timeText: '8 โมงเช้า' }), { now: NOW, tz: BKK });
    expect(out.dueAtUtc && asBkk(out.dueAtUtc)).toBe('2026-09-18 08:00');
  });

  it('เวลาอ่านไม่ออก → problem ไม่ null ไม่เดา dueAtUtc', () => {
    const out = resolveImageItem(item({ timeText: 'อ่านไม่ออกเลย' }), { now: NOW, tz: BKK });
    expect(out.problem).not.toBeNull();
    expect(out.dueAtUtc).toBeNull();
  });

  it('ไม่มีวันที่ → problem', () => {
    const out = resolveImageItem(item({ dateLocal: null }), { now: NOW, tz: BKK });
    expect(out.problem).not.toBeNull();
  });

  it('วันที่ผิดรูปแบบ → problem', () => {
    const out = resolveImageItem(item({ dateLocal: '18/09/2026' }), { now: NOW, tz: BKK });
    expect(out.problem).not.toBeNull();
  });

  it('วันที่ไม่มีอยู่จริง (31 กันยายน) → problem', () => {
    const out = resolveImageItem(item({ dateLocal: '2026-09-31' }), { now: NOW, tz: BKK });
    expect(out.problem).not.toBeNull();
  });

  it('ปีไกลผิดปกติ (ลืมแปลง พ.ศ. → ค.ศ.) → problem', () => {
    // พ.ศ. 2569 หลุดมาทั้งอย่างนั้น (ไม่ลบ 543)
    const out = resolveImageItem(item({ dateLocal: '2569-09-18' }), { now: NOW, tz: BKK });
    expect(out.problem).not.toBeNull();
    expect(out.problem).toContain('พ.ศ./ค.ศ.');
  });

  it('เก็บ confidence จากโมเดลไว้ตรงๆ เมื่อสำเร็จ', () => {
    const out = resolveImageItem(item({ confidence: 0.72 }), { now: NOW, tz: BKK });
    expect(out.confidence).toBe(0.72);
  });

  // เจอจริงตอนทดสอบกับตารางเวร: โมเดลคัดลอกหัวคอลัมน์ "เวรเช้า (07-15)" มาทั้งช่วง
  // ไม่ใช่เวลาจุดเดียว — ต้องตีความว่าเตือนตอนเริ่มกะ (จุดเริ่มของช่วง)
  it('timeText เป็นช่วงแบบตารางเวร ("07-15") → ใช้เวลาเริ่มต้นของช่วง', () => {
    const out = resolveImageItem(item({ timeText: '07-15' }), { now: NOW, tz: BKK });
    expect(out.problem).toBeNull();
    expect(out.dueAtUtc && asBkk(out.dueAtUtc)).toBe('2026-09-18 07:00');
  });

  it('ช่วงที่ข้ามเที่ยงคืน ("23-07") → ใช้เวลาเริ่มต้น ไม่ใช่เวลาสิ้นสุด', () => {
    const out = resolveImageItem(item({ timeText: '23-07' }), { now: NOW, tz: BKK });
    expect(out.dueAtUtc && asBkk(out.dueAtUtc)).toBe('2026-09-18 23:00');
  });

  it('ช่วงที่มีนาทีระบุ ("07:30-15:00") → ใช้นาทีของจุดเริ่มต้นด้วย', () => {
    const out = resolveImageItem(item({ timeText: '07:30-15:00' }), { now: NOW, tz: BKK });
    expect(out.dueAtUtc && asBkk(out.dueAtUtc)).toBe('2026-09-18 07:30');
  });
});

describe('resolveImageItem — recurring (จากตารางเวร/ตารางเรียน)', () => {
  it('สร้าง rrule รายสัปดาห์จากวันที่ระบุ', () => {
    const out = resolveImageItem(
      item({ kind: 'recurring', dateLocal: null, weekday: 'MO', timeText: '07:00' }),
      { now: NOW, tz: BKK },
    );
    expect(out.problem).toBeNull();
    expect(out.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(out.fireAtMinuteLocal).toBe(420);
  });

  it('ไม่มี weekday → problem', () => {
    const out = resolveImageItem(
      item({ kind: 'recurring', dateLocal: null, weekday: null }),
      { now: NOW, tz: BKK },
    );
    expect(out.problem).not.toBeNull();
  });

  it('เวลาอ่านไม่ออก → problem แม้จะมี weekday', () => {
    const out = resolveImageItem(
      item({ kind: 'recurring', dateLocal: null, weekday: 'TU', timeText: 'พร่ามัว' }),
      { now: NOW, tz: BKK },
    );
    expect(out.problem).not.toBeNull();
  });

  it('ครบทั้ง 7 วันแปลงเป็น rrule ถูกต้อง', () => {
    const days: Array<ImageReminderItem['weekday']> = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'];
    for (const d of days) {
      const out = resolveImageItem(
        item({ kind: 'recurring', dateLocal: null, weekday: d, timeText: '09:00' }),
        { now: NOW, tz: BKK },
      );
      expect(out.rrule).toBe(`FREQ=WEEKLY;BYDAY=${d}`);
    }
  });
});
