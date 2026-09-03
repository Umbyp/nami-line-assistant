import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { dbReady, resetDb, seedChatAndUser } from './helpers/db.js';
import {
  confirmReminderDraft,
  confirmableItems,
  createReminderDraft,
  discardReminderDraft,
  readDraftItems,
} from '../src/reminders/draftService.js';
import type { ResolvedDraftItem } from '../src/nlu/imageSchema.js';

const d = dbReady ? describe : describe.skip;

const CHAT = 'Utest-draft-000000000000000001';
const USER = 'Utest-draftuser-00000000000001';
let chatId = '';

function onceItem(over: Partial<ResolvedDraftItem> = {}): ResolvedDraftItem {
  return {
    title: 'นัดตรวจติดตามอาการ',
    kind: 'once',
    dueAtUtc: new Date('2026-09-18T02:30:00.000Z'), // 09:30 ไทย
    rrule: null,
    fireAtMinuteLocal: null,
    confidence: 0.9,
    problem: null,
    ...over,
  };
}

function recurringItem(over: Partial<ResolvedDraftItem> = {}): ResolvedDraftItem {
  return {
    title: 'เวรเช้า',
    kind: 'recurring',
    dueAtUtc: null,
    rrule: 'FREQ=WEEKLY;BYDAY=MO',
    fireAtMinuteLocal: 420,
    confidence: 0.85,
    problem: null,
    ...over,
  };
}

d('draftService', () => {
  beforeEach(async () => {
    await resetDb();
    ({ chatId } = await seedChatAndUser({ lineChatId: CHAT, lineUserId: USER }));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('confirmableItems กรองเฉพาะ item ที่ problem เป็น null', () => {
    const ok = onceItem();
    const bad = onceItem({ problem: 'อ่านเวลาไม่ออก', dueAtUtc: null });
    expect(confirmableItems([ok, bad])).toEqual([ok]);
  });

  it('สร้าง draft แล้วอ่านกลับมาได้ครบ (round-trip ผ่าน JSON)', async () => {
    const draft = await createReminderDraft({
      chatId, createdBy: USER,
      items: [onceItem(), recurringItem()],
      unclearNotes: ['ตัวเลขวันที่เลือนนิดหน่อย'],
    });
    expect(draft.status).toBe('pending');
    expect(draft.source).toBe('image');

    const { items, unclearNotes } = readDraftItems(draft);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toBe('นัดตรวจติดตามอาการ');
    expect(items[0]?.dueAtUtc?.toISOString()).toBe('2026-09-18T02:30:00.000Z');
    expect(items[1]?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(unclearNotes).toEqual(['ตัวเลขวันที่เลือนนิดหน่อย']);
  });

  it('ยืนยัน draft → สร้างเตือนจริงครบทุกรายการที่ problem เป็น null', async () => {
    const draft = await createReminderDraft({
      chatId, createdBy: USER,
      items: [onceItem(), recurringItem()],
      unclearNotes: [],
    });

    const out = await confirmReminderDraft(draft.id, chatId);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.created).toHaveLength(2);
    expect(out.skipped).toBe(0);

    const reminders = await prisma.reminder.findMany({ where: { chatId } });
    expect(reminders).toHaveLength(2);
    expect(reminders.find((r) => r.kind === 'once')?.source).toBe('image');
    expect(reminders.find((r) => r.kind === 'recurring')?.rrule).toBe('FREQ=WEEKLY;BYDAY=MO');

    // occurrence แรกต้องถูกสร้างด้วย (createOnceReminder/createRecurringReminder ทำให้อัตโนมัติ)
    const occCount = await prisma.reminderOccurrence.count({
      where: { reminder: { chatId } },
    });
    expect(occCount).toBe(2);
  });

  it('ข้าม item ที่ problem ไม่ null ตอนยืนยัน (ไม่สร้างเตือนที่อ่านเวลาไม่ออก)', async () => {
    const draft = await createReminderDraft({
      chatId, createdBy: USER,
      items: [onceItem(), onceItem({ title: 'อ่านไม่ออก', problem: 'เวลาพัง', dueAtUtc: null })],
      unclearNotes: [],
    });

    const out = await confirmReminderDraft(draft.id, chatId);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.created).toHaveLength(1);
      expect(out.skipped).toBe(1);
    }
  });

  it('ยืนยันซ้ำครั้งที่สอง → already_handled ไม่สร้างเตือนซ้ำ', async () => {
    const draft = await createReminderDraft({
      chatId, createdBy: USER, items: [onceItem()], unclearNotes: [],
    });
    await confirmReminderDraft(draft.id, chatId);
    const second = await confirmReminderDraft(draft.id, chatId);

    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.reason).toBe('already_handled');
    expect(await prisma.reminder.count({ where: { chatId } })).toBe(1);
  });

  it('ยืนยันพร้อมกัน 5 ครั้ง → สร้างเตือนแค่ชุดเดียว (claim แบบ atomic กันกดซ้ำ)', async () => {
    const draft = await createReminderDraft({
      chatId, createdBy: USER, items: [onceItem()], unclearNotes: [],
    });

    const results = await Promise.all(
      Array.from({ length: 5 }, () => confirmReminderDraft(draft.id, chatId)),
    );
    const succeeded = results.filter((r) => r.ok);
    expect(succeeded).toHaveLength(1);
    expect(await prisma.reminder.count({ where: { chatId } })).toBe(1);
  });

  it('draft ที่หมดอายุแล้ว → ปฏิเสธและไม่สร้างเตือน', async () => {
    const draft = await prisma.reminderDraft.create({
      data: {
        chatId, createdBy: USER, source: 'image', status: 'pending',
        expiresAt: new Date(Date.now() - 1000),
        payload: { items: [], unclearNotes: [] },
      },
    });

    const out = await confirmReminderDraft(draft.id, chatId);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('expired');

    const after = await prisma.reminderDraft.findUnique({ where: { id: draft.id } });
    expect(after?.status).toBe('discarded');
  });

  it('draft ของแชทอื่นต้องยืนยันไม่ได้ (id จาก postback เชื่อไม่ได้)', async () => {
    const draft = await createReminderDraft({
      chatId, createdBy: USER, items: [onceItem()], unclearNotes: [],
    });
    const other = await prisma.chat.create({ data: { lineId: 'Cattack-draft-00000000001', type: 'group' } });

    const out = await confirmReminderDraft(draft.id, other.id);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('not_found');
    expect(await prisma.reminder.count({ where: { chatId } })).toBe(0);
  });

  it('discardReminderDraft ทำเครื่องหมายว่าทิ้งแล้ว', async () => {
    const draft = await createReminderDraft({
      chatId, createdBy: USER, items: [onceItem()], unclearNotes: [],
    });
    expect(await discardReminderDraft(draft.id, chatId)).toBe(true);

    const after = await prisma.reminderDraft.findUnique({ where: { id: draft.id } });
    expect(after?.status).toBe('discarded');

    // ยืนยันหลังทิ้งไปแล้วต้องไม่ได้
    const out = await confirmReminderDraft(draft.id, chatId);
    expect(out.ok).toBe(false);
  });

  it('ไม่มี item ที่ยืนยันได้เลย → created ว่าง ไม่ throw', async () => {
    const draft = await createReminderDraft({
      chatId, createdBy: USER,
      items: [onceItem({ problem: 'พัง', dueAtUtc: null })],
      unclearNotes: ['ทั้งหมดอ่านไม่ออก'],
    });
    const out = await confirmReminderDraft(draft.id, chatId);
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.created).toEqual([]);
      expect(out.skipped).toBe(1);
    }
  });
});
