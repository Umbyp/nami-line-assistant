import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { dbReady, resetDb, seedChatAndUser } from './helpers/db.js';
import {
  cancelReminder,
  createOnceReminder,
  listActiveReminders,
  retimeReminder,
} from '../src/reminders/service.js';

/**
 * integration test — แตะ Postgres จริง
 * เพราะสิ่งที่ต้องพิสูจน์คือทรานแซกชัน, unique constraint และ FK
 * ซึ่ง mock แทนไม่ได้
 */
const d = dbReady ? describe : describe.skip;

const CHAT = 'Utest-reminders-0000000000000001';
const USER = 'Utest-user-000000000000000000001';

let chatId = '';

d('reminders service', () => {
  beforeEach(async () => {
    await resetDb();
    ({ chatId } = await seedChatAndUser({ lineChatId: CHAT, lineUserId: USER }));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const due = new Date('2026-09-03T11:00:00.000Z'); // 18:00 ไทย

  it('createOnceReminder สร้าง reminder + occurrence แรกพร้อมกัน', async () => {
    const r = await createOnceReminder({
      chatId,
      createdBy: USER,
      title: 'กินยา',
      dueAtUtc: due,
    });

    expect(r.kind).toBe('once');
    expect(r.status).toBe('active');
    expect(r.dueAtUtc?.toISOString()).toBe(due.toISOString());
    expect(r.nextFireAtUtc?.toISOString()).toBe(due.toISOString());

    const occ = await prisma.reminderOccurrence.findMany({ where: { reminderId: r.id } });
    expect(occ).toHaveLength(1);
    expect(occ[0]?.status).toBe('pending');
    expect(occ[0]?.fireAtUtc.toISOString()).toBe(due.toISOString());
  });

  it('เก็บเวลาเป็น UTC ใน DB (ไม่ใช่เวลาไทย)', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: due });
    const rows = await prisma.$queryRaw<Array<{ due: Date }>>`
      SELECT due_at_utc AS due FROM reminders WHERE id = ${r.id}::uuid`;
    expect(rows[0]?.due.toISOString()).toBe('2026-09-03T11:00:00.000Z');
  });

  it('unique(reminderId, fireAtUtc) กันสร้าง occurrence เวลาเดียวกันซ้ำ', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: due });
    await expect(
      prisma.reminderOccurrence.create({ data: { reminderId: r.id, fireAtUtc: due } }),
    ).rejects.toThrow();
  });

  it('cancelReminder เปลี่ยนสถานะ + ทำ occurrence ที่ค้างเป็น skipped', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: due });
    const out = await cancelReminder(r.id, chatId);

    expect(out?.status).toBe('cancelled');
    expect(out?.nextFireAtUtc).toBeNull();

    const occ = await prisma.reminderOccurrence.findMany({ where: { reminderId: r.id } });
    expect(occ[0]?.status).toBe('skipped');
  });

  it('cancelReminder ของแชทอื่นต้องไม่สำเร็จ (id จาก postback เชื่อไม่ได้)', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'ความลับ', dueAtUtc: due });
    const other = await prisma.chat.create({
      data: { lineId: 'Cattacker-000000000000000000001', type: 'group' },
    });

    const out = await cancelReminder(r.id, other.id);
    expect(out).toBeNull();

    const still = await prisma.reminder.findUnique({ where: { id: r.id } });
    expect(still?.status).toBe('active');
  });

  it('cancelReminder ซ้ำสองครั้งไม่พัง', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: due });
    await cancelReminder(r.id, chatId);
    const again = await cancelReminder(r.id, chatId);
    expect(again?.status).toBe('cancelled');
  });

  it('retimeReminder ทิ้ง occurrence เดิมแล้วสร้างใหม่ (ไม่แก้แถวเดิม)', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: due });
    const oldOcc = await prisma.reminderOccurrence.findFirst({ where: { reminderId: r.id } });

    const newDue = new Date('2026-09-04T02:00:00.000Z'); // 09:00 ไทย
    const out = await retimeReminder(r.id, chatId, newDue);

    expect(out?.dueAtUtc?.toISOString()).toBe(newDue.toISOString());
    expect(out?.nextFireAtUtc?.toISOString()).toBe(newDue.toISOString());

    const all = await prisma.reminderOccurrence.findMany({
      where: { reminderId: r.id },
      orderBy: { fireAtUtc: 'asc' },
    });
    expect(all).toHaveLength(2);
    // แถวเดิมต้องยังอยู่แต่เป็น skipped — id เดิมคือ jobId ของ BullMQ
    const old = all.find((o) => o.id === oldOcc?.id);
    expect(old?.status).toBe('skipped');
    const fresh = all.find((o) => o.id !== oldOcc?.id);
    expect(fresh?.status).toBe('pending');
  });

  it('retime การเตือนที่ยกเลิกไปแล้ว → กลับมา active', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: due });
    await cancelReminder(r.id, chatId);
    const out = await retimeReminder(r.id, chatId, new Date('2026-09-05T02:00:00.000Z'));
    expect(out?.status).toBe('active');
  });

  it('retime ของแชทอื่นต้องไม่สำเร็จ', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: due });
    const other = await prisma.chat.create({
      data: { lineId: 'Cattacker-000000000000000000002', type: 'group' },
    });
    expect(await retimeReminder(r.id, other.id, new Date())).toBeNull();
  });

  it('listActiveReminders เรียงตามเวลาที่จะยิงถัดไป และไม่เอาที่ยกเลิกแล้ว', async () => {
    const late = await createOnceReminder({
      chatId, createdBy: USER, title: 'ทีหลัง',
      dueAtUtc: new Date('2026-09-10T02:00:00.000Z'),
    });
    await createOnceReminder({
      chatId, createdBy: USER, title: 'ก่อน',
      dueAtUtc: new Date('2026-09-04T02:00:00.000Z'),
    });
    const cancelled = await createOnceReminder({
      chatId, createdBy: USER, title: 'ยกเลิกแล้ว',
      dueAtUtc: new Date('2026-09-05T02:00:00.000Z'),
    });
    await cancelReminder(cancelled.id, chatId);

    const list = await listActiveReminders(chatId);
    expect(list.map((x) => x.title)).toEqual(['ก่อน', 'ทีหลัง']);
    expect(list.map((x) => x.id)).toContain(late.id);
  });

  it('ห้ามลบ user ที่ยังมีการเตือนค้างอยู่ (onDelete: Restrict)', async () => {
    await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: due });
    await expect(prisma.user.delete({ where: { lineUserId: USER } })).rejects.toThrow();
  });

  it('ลบ chat แล้ว reminder + occurrence หายตาม (onDelete: Cascade)', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: due });
    await prisma.chat.delete({ where: { id: chatId } });
    expect(await prisma.reminder.findUnique({ where: { id: r.id } })).toBeNull();
    expect(await prisma.reminderOccurrence.count({ where: { reminderId: r.id } })).toBe(0);
  });
});
