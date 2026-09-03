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

// ─────────────────────────────────────────────────────────────
// P3: reminderFire + reminderList + reminderConfirm แบบซ้ำ
// ─────────────────────────────────────────────────────────────
import { reminderFire } from '../src/line/flex/reminderFire.js';
import { reminderList, LIST_MAX } from '../src/line/flex/reminderList.js';
import type { Reminder } from '@prisma/client';

const OID = '99999999-8888-4777-8666-555555555555';

function fireInput(over: Partial<Parameters<typeof reminderFire>[0]> = {}) {
  return {
    occurrenceId: OID,
    reminderId: ID,
    title: 'กินยา',
    fireAtUtc: bkk('2026-09-03T18:00'),
    isRecurring: false,
    tz: BKK,
    now: NOW,
    ...over,
  };
}

function footerButtons(msg: any): any[] {
  const flat: any[] = [];
  const walk = (n: any): void => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.type === 'button') flat.push(n);
      Object.values(n).forEach(walk);
    }
  };
  walk(msg.contents.footer);
  return flat;
}

describe('reminderFire', () => {
  it('altText มีชื่อเรื่อง (คนเห็นอันนี้ใน notification)', () => {
    expect(reminderFire(fireInput()).altText).toContain('กินยา');
  });

  it('มี 4 ปุ่มตามที่ตกลง: เสร็จแล้ว / เลื่อน 10 นาที / เลื่อน 1 ชม. / ปิดการเตือนนี้', () => {
    const labels = footerButtons(reminderFire(fireInput())).map((b) => b.action.label);
    expect(labels).toEqual(['เสร็จแล้ว', 'เลื่อน 10 นาที', 'เลื่อน 1 ชม.', 'ปิดการเตือนนี้']);
  });

  it('ปุ่มเสร็จแล้วและเลื่อน พา occurrenceId ไป (เลื่อนแค่รอบนี้ ไม่ใช่ทั้งชุด)', () => {
    const bs = footerButtons(reminderFire(fireInput()));
    for (const b of bs.slice(0, 3)) {
      const out = decodePostback(b.action.data);
      expect(out.ok).toBe(true);
      if (out.ok) expect('oid' in out.action && out.action.oid).toBe(OID);
    }
  });

  it('ปุ่มปิดการเตือน พา reminderId ไป (ปิดทั้งชุด)', () => {
    const off = footerButtons(reminderFire(fireInput())).at(-1);
    const out = decodePostback(off.action.data);
    expect(out.ok).toBe(true);
    if (out.ok) expect('id' in out.action && out.action.id).toBe(ID);
  });

  it('ปุ่มเลื่อนพาจำนวนนาทีที่ถูกต้อง', () => {
    const bs = footerButtons(reminderFire(fireInput()));
    const mins = bs
      .map((b) => decodePostback(b.action.data))
      .filter((r) => r.ok && r.action.a === 'rm.snooze')
      .map((r) => (r.ok && 'm' in r.action ? r.action.m : null));
    expect(mins).toEqual([10, 60]);
  });

  it('การเตือนซ้ำแสดงว่าซ้ำแบบไหน', () => {
    const all = texts(
      reminderFire(
        fireInput({ isRecurring: true, rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', fireAtMinuteLocal: 480 }),
      ),
    ).join(' | ');
    expect(all).toContain('ทุกวันจันทร์-ศุกร์');
  });

  it('การเตือนครั้งเดียวไม่แสดงข้อความเรื่องความซ้ำ', () => {
    const all = texts(reminderFire(fireInput())).join(' | ');
    expect(all).not.toContain('ทุก');
  });
});

function fakeReminder(over: Partial<Reminder> = {}): Reminder {
  return {
    id: ID,
    chatId: 'c1',
    createdBy: 'u1',
    title: 'ส่งรายงาน',
    note: null,
    kind: 'once',
    dueAtUtc: bkk('2026-09-04T09:00'),
    rrule: null,
    everyMinutes: null,
    fireAtMinuteLocal: null,
    mentionUserIds: [],
    source: 'text',
    status: 'active',
    nextFireAtUtc: bkk('2026-09-04T09:00'),
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as Reminder;
}

describe('reminderList', () => {
  it('ไม่มีรายการ → ตอบเป็นข้อความ ไม่ใช่ carousel ว่าง', () => {
    const m = reminderList({ reminders: [], tz: BKK, now: NOW });
    expect(m.type).toBe('text');
  });

  it('มีรายการ → carousel 1 bubble ต่อ 1 การเตือน', () => {
    const m = reminderList({ reminders: [fakeReminder(), fakeReminder({ id: OID })], tz: BKK, now: NOW }) as any;
    expect(m.type).toBe('flex');
    expect(m.contents.type).toBe('carousel');
    expect(m.contents.contents).toHaveLength(2);
  });

  it('ตัดที่ LIST_MAX เพราะ LINE จำกัด carousel', () => {
    const many = Array.from({ length: 25 }, (_, i) => fakeReminder({ id: `${i}` }));
    const m = reminderList({ reminders: many, total: 25, tz: BKK, now: NOW }) as any;
    expect(m.contents.contents).toHaveLength(LIST_MAX);
  });

  it('การเตือนครั้งเดียวมีปุ่มเปลี่ยนเวลา + ลบ', () => {
    const m = reminderList({ reminders: [fakeReminder()], tz: BKK, now: NOW }) as any;
    const labels = footerButtons({ contents: m.contents.contents[0] }).map((b) => b.action.label);
    expect(labels).toEqual(['เปลี่ยนเวลา', 'ลบ']);
  });

  it('การเตือนซ้ำมีแค่ปุ่มลบ (เปลี่ยนเวลาของทุกวันไม่ใช่การเลือกวันเวลาครั้งเดียว)', () => {
    const rec = fakeReminder({ kind: 'recurring', rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480 });
    const m = reminderList({ reminders: [rec], tz: BKK, now: NOW }) as any;
    const labels = footerButtons({ contents: m.contents.contents[0] }).map((b) => b.action.label);
    expect(labels).toEqual(['ลบ']);
  });

  it('แสดงคำอธิบายความซ้ำในการ์ด', () => {
    const rec = fakeReminder({ kind: 'recurring', rrule: 'FREQ=MONTHLY;BYMONTHDAY=25', fireAtMinuteLocal: 540 });
    const m = reminderList({ reminders: [rec], tz: BKK, now: NOW }) as any;
    const all = texts(m.contents.contents[0]).join(' | ');
    expect(all).toContain('ทุกวันที่ 25 ของเดือน 09:00');
  });

  it('ปุ่มลบพา reminderId ที่ถอดกลับได้', () => {
    const m = reminderList({ reminders: [fakeReminder()], tz: BKK, now: NOW }) as any;
    const del = footerButtons({ contents: m.contents.contents[0] }).at(-1);
    const out = decodePostback(del.action.data);
    expect(out.ok).toBe(true);
    if (out.ok) expect('id' in out.action && out.action.id).toBe(ID);
  });
});

describe('reminderConfirm — แบบซ้ำ', () => {
  const rec = {
    ...base,
    recurrenceLabel: 'ทุกวันจันทร์-ศุกร์ 08:00',
    dueAtUtc: bkk('2026-09-04T08:00'),
  };

  it('altText บอกความซ้ำ ไม่ใช่เวลาครั้งเดียว', () => {
    expect(reminderConfirm(rec).altText).toContain('ทุกวันจันทร์-ศุกร์');
  });

  it('แสดงทั้งความซ้ำและรอบแรก', () => {
    const all = texts(reminderConfirm(rec)).join(' | ');
    expect(all).toContain('ทุกวันจันทร์-ศุกร์ 08:00');
    expect(all).toContain('ครั้งแรก');
  });

  it('ไม่มีปุ่ม datetimepicker (ใช้ดูรายการแทน)', () => {
    const bs = buttons(reminderConfirm(rec));
    expect(bs[0].action.type).toBe('postback');
    expect(bs[0].action.label).toBe('ดูรายการ');
  });

  it('บอกผู้ใช้เมื่อรอบแรกถูกเลื่อนเพราะช่วงเวลาเงียบ', () => {
    const all = texts(reminderConfirm({ ...rec, quietHoursShifted: true })).join(' | ');
    expect(all).toContain('ช่วงเวลาเงียบ');
  });
});

// ─────────────────────────────────────────────────────────────
// P4: vaultSearchResult
// ─────────────────────────────────────────────────────────────
import { vaultSearchResult, VAULT_RESULT_MAX } from '../src/line/flex/vaultSearchResult.js';
import type { VaultSearchHit } from '../src/vault/search.js';

function fakeHit(over: Partial<VaultSearchHit> = {}): VaultSearchHit {
  return {
    id: ID,
    kind: 'text',
    title: 'ไฟล์สัญญา',
    contentText: 'เนื้อหาบางส่วน',
    storageKey: null,
    mime: null,
    originalFileName: null,
    createdAt: NOW,
    score: 1,
    ...over,
  };
}

describe('vaultSearchResult', () => {
  it('ไม่มีผลลัพธ์ → ตอบเป็นข้อความบอกตรงๆ ว่าหาไม่เจอ', () => {
    const m = vaultSearchResult({ hits: [], query: 'ไดโนเสาร์', tz: BKK, now: NOW });
    expect(m.type).toBe('text');
    if (m.type === 'text') expect(m.text).toContain('ไดโนเสาร์');
  });

  it('มีผลลัพธ์ → carousel 1 bubble ต่อ 1 รายการ', () => {
    const m = vaultSearchResult({
      hits: [fakeHit(), fakeHit({ id: OID, title: 'อีกไฟล์' })],
      query: 'สัญญา', tz: BKK, now: NOW,
    }) as any;
    expect(m.type).toBe('flex');
    expect(m.contents.type).toBe('carousel');
    expect(m.contents.contents).toHaveLength(2);
  });

  it('ตัดที่ VAULT_RESULT_MAX', () => {
    const many = Array.from({ length: 15 }, (_, i) => fakeHit({ id: `${i}` }));
    const m = vaultSearchResult({ hits: many, query: 'x', tz: BKK, now: NOW }) as any;
    expect(m.contents.contents).toHaveLength(VAULT_RESULT_MAX);
  });

  it('ลิงก์: ปุ่มเปิดลิงก์เป็น uri action ตรงกับ URL จริง', () => {
    const m = vaultSearchResult({
      hits: [fakeHit({ kind: 'link', contentText: 'https://example.com/doc' })],
      query: 'x', tz: BKK, now: NOW,
    }) as any;
    const btn = footerButtons({ contents: m.contents.contents[0] })[0];
    expect(btn.action.type).toBe('uri');
    expect(btn.action.uri).toBe('https://example.com/doc');
  });

  it('ไฟล์ที่มี storageKey: ปุ่มขอไฟล์กลับเป็น postback พา itemId', () => {
    const m = vaultSearchResult({
      hits: [fakeHit({ kind: 'file', storageKey: 'vault/x/1.pdf', title: 'เอกสาร.pdf' })],
      query: 'x', tz: BKK, now: NOW,
    }) as any;
    const btn = footerButtons({ contents: m.contents.contents[0] })[0];
    expect(btn.action.type).toBe('postback');
    const out = decodePostback(btn.action.data);
    expect(out.ok).toBe(true);
    if (out.ok) expect('id' in out.action && out.action.id).toBe(ID);
  });

  it('รูปที่มี storageKey: ปุ่มบอกว่า "ส่งรูปกลับมา" ไม่ใช่ไฟล์', () => {
    const m = vaultSearchResult({
      hits: [fakeHit({ kind: 'image', storageKey: 'vault/x/1.jpg', title: null })],
      query: 'x', tz: BKK, now: NOW,
    }) as any;
    const btn = footerButtons({ contents: m.contents.contents[0] })[0];
    expect(btn.action.label).toBe('ส่งรูปกลับมา');
  });

  it('ข้อความ/ลิงก์ไม่มี storageKey เลย และไม่ใช่ลิงก์ → ไม่มี footer', () => {
    const m = vaultSearchResult({ hits: [fakeHit({ kind: 'text' })], query: 'x', tz: BKK, now: NOW }) as any;
    expect(m.contents.contents[0].footer).toBeUndefined();
  });

  it('แสดงตัวอย่างเนื้อหาสำหรับ text/link แต่ไม่แสดงสำหรับ image/file', () => {
    const textBubble = vaultSearchResult({
      hits: [fakeHit({ kind: 'text', contentText: 'เนื้อหาลับ' })], query: 'x', tz: BKK, now: NOW,
    }) as any;
    expect(texts(textBubble.contents.contents[0]).join(' ')).toContain('เนื้อหาลับ');

    const imgBubble = vaultSearchResult({
      hits: [fakeHit({ kind: 'image', contentText: 'ไม่ควรโชว์', storageKey: 'vault/x/1.jpg' })],
      query: 'x', tz: BKK, now: NOW,
    }) as any;
    expect(texts(imgBubble.contents.contents[0]).join(' ')).not.toContain('ไม่ควรโชว์');
  });
});

// ─────────────────────────────────────────────────────────────
// P6: vaultSearchResult โหมด "ดูของล่าสุด" + settingsView
// ─────────────────────────────────────────────────────────────
import { settingsView } from '../src/line/flex/settingsView.js';
import type { User } from '@prisma/client';

describe('vaultSearchResult — โหมดดูของล่าสุด (query ว่าง)', () => {
  it('ไม่มีของเก็บไว้เลย → ข้อความชวนส่งของมา ไม่ใช่ข้อความ "หาไม่เจอ"', () => {
    const m = vaultSearchResult({ hits: [], query: '', tz: BKK, now: NOW });
    expect(m.type).toBe('text');
    if (m.type === 'text') {
      expect(m.text).not.toContain('หา');
      expect(m.text).toContain('ส่งรูป');
    }
  });

  it('มีของ → altText บอกว่าเป็น "ของล่าสุด" ไม่ใช่ "เจอ N รายการ"', () => {
    const m = vaultSearchResult({ hits: [fakeHit()], query: '', tz: BKK, now: NOW });
    expect(m.type).toBe('flex');
    if (m.type === 'flex') expect(m.altText).toContain('ล่าสุด');
  });

  it('มีคำค้น (query ไม่ว่าง) ยังใช้ข้อความค้นหาแบบเดิม', () => {
    const empty = vaultSearchResult({ hits: [], query: 'ไดโนเสาร์', tz: BKK, now: NOW });
    expect(empty.type).toBe('text');
    if (empty.type === 'text') expect(empty.text).toContain('ไดโนเสาร์');
  });
});

function fakeUser(over: Partial<User> = {}): User {
  return {
    lineUserId: 'U1',
    displayName: 'ผู้ทดสอบ',
    tz: 'Asia/Bangkok',
    plan: 'free',
    quietHoursStart: 1320,
    quietHoursEnd: 420,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  } as User;
}

describe('settingsView', () => {
  it('แสดงแผนและช่วงเวลาเงียบปัจจุบัน', () => {
    const m = settingsView(fakeUser());
    const all = texts(m).join(' | ');
    expect(all).toContain('Free');
    expect(all).toContain('22:00');
    expect(all).toContain('07:00');
  });

  it('มีปุ่มปรับเวลาเริ่ม/สิ้นสุด + ปิดช่วงเวลาเงียบ เมื่อเปิดใช้งานอยู่', () => {
    const m = settingsView(fakeUser()) as any;
    const buttons = footerButtons({ contents: m.contents });
    const labels = buttons.map((b: any) => b.action.label);
    expect(labels).toEqual(['ปรับเวลาเริ่ม', 'ปรับเวลาสิ้นสุด', 'ปิดช่วงเวลาเงียบ']);
    expect(buttons[0].action.type).toBe('datetimepicker');
    expect(buttons[0].action.mode).toBe('time');
  });

  it('ปิดช่วงเวลาเงียบอยู่ (start === end) → แสดง "ปิดอยู่" และมีแค่ปุ่มเปิด', () => {
    const m = settingsView(fakeUser({ quietHoursStart: 0, quietHoursEnd: 0 })) as any;
    expect(texts(m).join(' | ')).toContain('ปิดอยู่');
    const buttons = footerButtons({ contents: m.contents });
    expect(buttons.map((b: any) => b.action.label)).toEqual(['เปิดช่วงเวลาเงียบ']);
    expect(buttons[0].action.data).toContain('quiet_on');
  });

  it('แผน pro แสดง "Pro"', () => {
    const m = settingsView(fakeUser({ plan: 'pro' }));
    expect(texts(m).join(' | ')).toContain('Pro');
  });

  it('ปุ่มปรับเวลาตั้งค่า initial ตรงกับเวลาปัจจุบัน', () => {
    const m = settingsView(fakeUser({ quietHoursStart: 90, quietHoursEnd: 600 })) as any;
    const buttons = footerButtons({ contents: m.contents });
    expect(buttons[0].action.initial).toBe('01:30');
    expect(buttons[1].action.initial).toBe('10:00');
  });
});

// ─────────────────────────────────────────────────────────────
// feature 3: imageReminderReview (P6-add-on)
// ─────────────────────────────────────────────────────────────
import { imageReminderReview } from '../src/line/flex/imageReminderReview.js';
import type { ReminderDraft } from '@prisma/client';

function fakeDraft(payload: unknown, over: Partial<ReminderDraft> = {}): ReminderDraft {
  return {
    id: ID,
    chatId: 'c1',
    createdBy: 'u1',
    status: 'pending',
    source: 'image',
    payload,
    expiresAt: NOW,
    createdAt: NOW,
    ...over,
  } as ReminderDraft;
}

describe('imageReminderReview', () => {
  it('มีรายการที่ยืนยันได้ → แสดงชื่อเรื่องทุกอัน + ปุ่มยืนยันทั้งหมด/ไม่ต้อง', () => {
    const draft = fakeDraft({
      items: [
        { title: 'นัดตรวจ', kind: 'once', dueAtUtc: '2026-09-18T02:30:00.000Z', rrule: null, fireAtMinuteLocal: null, confidence: 0.9, problem: null },
        { title: 'เวรเช้า', kind: 'recurring', dueAtUtc: null, rrule: 'FREQ=WEEKLY;BYDAY=MO', fireAtMinuteLocal: 420, confidence: 0.8, problem: null },
      ],
      unclearNotes: [],
    });
    const m = imageReminderReview(draft);
    expect(m.altText).toContain('2 รายการ');

    const all = texts(m).join(' | ');
    expect(all).toContain('นัดตรวจ');
    expect(all).toContain('เวรเช้า');

    const buttons = footerButtons({ contents: m.contents as any });
    expect(buttons.map((b: any) => b.action.label)).toEqual(['ยืนยันทั้งหมด (2 รายการ)', 'ไม่ต้อง']);
  });

  it('ปุ่มยืนยัน/ไม่ต้อง พา draftId ที่ถอดกลับได้', () => {
    const draft = fakeDraft({
      items: [{ title: 'x', kind: 'once', dueAtUtc: '2026-09-18T02:30:00.000Z', rrule: null, fireAtMinuteLocal: null, confidence: 0.9, problem: null }],
      unclearNotes: [],
    });
    const buttons = footerButtons({ contents: imageReminderReview(draft).contents as any });
    for (const b of buttons) {
      const out = decodePostback(b.action.data);
      expect(out.ok).toBe(true);
      if (out.ok) expect('id' in out.action && out.action.id).toBe(ID);
    }
  });

  it('มี item ที่อ่านไม่ออกปนมา → แสดงกล่องเตือนแยกจากรายการที่ยืนยันได้', () => {
    const draft = fakeDraft({
      items: [
        { title: 'นัดตรวจ', kind: 'once', dueAtUtc: '2026-09-18T02:30:00.000Z', rrule: null, fireAtMinuteLocal: null, confidence: 0.9, problem: null },
        { title: 'อ่านไม่ออก', kind: 'once', dueAtUtc: null, rrule: null, fireAtMinuteLocal: null, confidence: 0, problem: 'อ่านเวลาไม่ออก' },
      ],
      unclearNotes: [],
    });
    const all = texts(imageReminderReview(draft)).join(' | ');
    expect(all).toContain('อ่านไม่ออก 1 รายการ');
  });

  it('มี unclearNotes → แสดงคำเตือนให้ตรวจสอบเอง', () => {
    const draft = fakeDraft({
      items: [{ title: 'x', kind: 'once', dueAtUtc: '2026-09-18T02:30:00.000Z', rrule: null, fireAtMinuteLocal: null, confidence: 0.9, problem: null }],
      unclearNotes: ['ตัวเลขวันที่เลือน'],
    });
    const all = texts(imageReminderReview(draft)).join(' | ');
    expect(all).toContain('ตัวเลขวันที่เลือน');
    expect(all).toContain('ไม่มั่นใจ');
  });

  it('ไม่มี item ที่ยืนยันได้เลย → ปุ่มเดียว "รับทราบ" ไม่มีปุ่มยืนยัน', () => {
    const draft = fakeDraft({
      items: [{ title: 'พัง', kind: 'once', dueAtUtc: null, rrule: null, fireAtMinuteLocal: null, confidence: 0, problem: 'พัง' }],
      unclearNotes: ['ทั้งหมดอ่านไม่ออก'],
    });
    const m = imageReminderReview(draft);
    const buttons = footerButtons({ contents: m.contents as any });
    expect(buttons.map((b: any) => b.action.label)).toEqual(['รับทราบ']);
  });
});
