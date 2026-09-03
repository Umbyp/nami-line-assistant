import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { reminderConfirm, pickerFormat } from '../src/line/flex/reminderConfirm.js';
import { decodePostback } from '../src/line/postback.js';
import { BKK } from '../src/lib/time.js';

function bkk(iso: string): Date {
  return DateTime.fromISO(iso, { zone: BKK }).toUTC().toJSDate();
}

const NOW = bkk('2026-09-03T10:30');
const ID = '11111111-2222-4333-8444-555555555555';

const base = {
  reminderId: ID,
  title: 'กินยาหลังอาหารเย็น',
  dueAtUtc: bkk('2026-09-03T18:00'),
  tz: BKK,
  now: NOW,
};

/** ดึงข้อความทั้งหมดใน bubble ออกมาเป็น array เพื่อ assert ง่าย */
function texts(node: unknown, acc: string[] = []): string[] {
  if (Array.isArray(node)) {
    node.forEach((n) => texts(n, acc));
    return acc;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    if (o['type'] === 'text' && typeof o['text'] === 'string') acc.push(o['text']);
    Object.values(o).forEach((v) => texts(v, acc));
  }
  return acc;
}

function buttons(msg: ReturnType<typeof reminderConfirm>): any[] {
  const bubble = msg.contents as any;
  return bubble.footer.contents;
}

describe('reminderConfirm', () => {
  it('altText มีทั้งเรื่องและเวลา (คนเห็นอันนี้ใน notification)', () => {
    const m = reminderConfirm(base);
    expect(m.altText).toContain('กินยาหลังอาหารเย็น');
    expect(m.altText).toContain('วันนี้ 18:00');
  });

  it('แสดงเวลาแบบอ่านง่าย', () => {
    const all = texts(reminderConfirm(base)).join(' | ');
    expect(all).toContain('กินยาหลังอาหารเย็น');
    expect(all).toContain('วันนี้ 18:00');
  });

  it('เวลาที่ไม่ใช่วันนี้/พรุ่งนี้ ต้องแสดงวันเต็มด้วย ไม่ให้กำกวมตอนย้อนดู', () => {
    const all = texts(
      reminderConfirm({ ...base, dueAtUtc: bkk('2026-09-14T18:00') }),
    ).join(' | ');
    expect(all).toContain('จ. 14 ก.ย. 18:00');
  });

  it('มี 2 ปุ่ม: เปลี่ยนเวลา (datetimepicker) และ ยกเลิก (postback)', () => {
    const bs = buttons(reminderConfirm(base));
    expect(bs).toHaveLength(2);
    expect(bs[0].action.type).toBe('datetimepicker');
    expect(bs[0].action.label).toBe('เปลี่ยนเวลา');
    expect(bs[0].action.mode).toBe('datetime');
    expect(bs[1].action.type).toBe('postback');
    expect(bs[1].action.label).toBe('ยกเลิก');
  });

  it('ปุ่มทั้งสองพา reminderId ที่ถอดกลับได้', () => {
    for (const b of buttons(reminderConfirm(base))) {
      const out = decodePostback(b.action.data);
      expect(out.ok).toBe(true);
      if (out.ok && 'id' in out.action) expect(out.action.id).toBe(ID);
    }
  });

  it('datetimepicker: initial = เวลาเดิม, min = เวลาปัจจุบัน (ห้ามเลือกอดีต)', () => {
    const a = buttons(reminderConfirm(base))[0].action;
    expect(a.initial).toBe('2026-09-03T18:00');
    expect(a.min).toBe('2026-09-03T10:30');
    expect(a.max).toBe('2029-09-03T10:30');
  });

  it('บอกผู้ใช้ตรงๆ เมื่อนามิเลื่อนวันให้อัตโนมัติ', () => {
    const all = texts(reminderConfirm({ ...base, shiftedDays: 1 })).join(' | ');
    expect(all).toContain('ผ่านไปแล้ว');
    expect(all).toContain('วันถัดไป');
  });

  it('ไม่ขึ้นข้อความเลื่อนวันถ้าไม่ได้เลื่อน', () => {
    const all = texts(reminderConfirm({ ...base, shiftedDays: 0 })).join(' | ');
    expect(all).not.toContain('วันถัดไป');
  });

  it('บอกวิธีแก้เมื่อยังไม่รู้ userId ของคนที่ถูกมอบหมาย', () => {
    const all = texts(
      reminderConfirm({ ...base, unknownAssignees: ['พี่โบ๊ท'] }),
    ).join(' | ');
    expect(all).toContain('พี่โบ๊ท');
    expect(all).toContain('พิมพ์ในกลุ่ม');
  });

  it('แสดง note และผู้รับมอบหมายเมื่อมี', () => {
    const all = texts(
      reminderConfirm({ ...base, note: 'ยาสีฟ้า 2 เม็ด', assigneeLabels: ['โบ๊ท', 'นุช'] }),
    ).join(' | ');
    expect(all).toContain('ยาสีฟ้า 2 เม็ด');
    expect(all).toContain('โบ๊ท, นุช');
  });
});

describe('pickerFormat', () => {
  it('ได้รูปแบบที่ datetimepicker ต้องการ เป็นเวลาไทย', () => {
    expect(pickerFormat(bkk('2026-09-03T18:00'), BKK)).toBe('2026-09-03T18:00');
  });

  it('ไม่หลุดเป็น UTC (เวลาตี 1 ไทยต้องไม่กลายเป็นวันก่อนหน้า)', () => {
    expect(pickerFormat(bkk('2026-09-04T01:00'), BKK)).toBe('2026-09-04T01:00');
  });
});
