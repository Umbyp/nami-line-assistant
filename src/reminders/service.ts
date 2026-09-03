import type { Reminder, ReminderOccurrence } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { firstOccurrence, nextOccurrence } from '../scheduler/nextOccurrence.js';

export interface CreateOnceInput {
  chatId: string;
  createdBy: string;
  title: string;
  note?: string | null;
  dueAtUtc: Date;
  source?: 'text' | 'image';
  mentionUserIds?: string[];
}

/**
 * สร้างการเตือนแบบครั้งเดียว + occurrence แรก ในทรานแซกชันเดียว
 *
 * ทำไมต้องสร้าง occurrence ตั้งแต่ตอนนี้ (ทั้งที่ scheduler มาใน P3):
 * occurrence คือหน่วยที่กันการยิงซ้ำ ถ้าปล่อยให้ scheduler สร้างเองทีหลัง
 * จะมีช่วงที่ reminder มีอยู่แต่ไม่มี occurrence — sweeper กับ enqueuer
 * อาจแข่งกันสร้างพร้อมกันแล้วได้สองแถว (unique constraint กันไว้ แต่ก็ยังพลาดง่าย)
 */
export async function createOnceReminder(input: CreateOnceInput): Promise<Reminder> {
  const reminder = await prisma.$transaction(async (tx) => {
    const r = await tx.reminder.create({
      data: {
        chatId: input.chatId,
        createdBy: input.createdBy,
        title: input.title,
        note: input.note ?? null,
        kind: 'once',
        dueAtUtc: input.dueAtUtc,
        nextFireAtUtc: input.dueAtUtc,
        source: input.source ?? 'text',
        mentionUserIds: input.mentionUserIds ?? [],
        status: 'active',
      },
    });

    await tx.reminderOccurrence.create({
      data: { reminderId: r.id, fireAtUtc: input.dueAtUtc, status: 'pending' },
    });

    return r;
  });

  logger.info(
    { reminderId: reminder.id, chatId: input.chatId, dueAtUtc: input.dueAtUtc },
    'สร้างการเตือนแบบครั้งเดียว',
  );
  return reminder;
}

/**
 * ยกเลิกการเตือน — ต้องเช็คว่าเป็นของแชทนั้นจริง
 * เพราะ id มาจาก postback ที่เดินทางผ่านเครื่องผู้ใช้ ห้ามเชื่อตรงๆ
 */
export async function cancelReminder(
  reminderId: string,
  chatId: string,
): Promise<Reminder | null> {
  const found = await prisma.reminder.findFirst({ where: { id: reminderId, chatId } });
  if (!found) return null;
  if (found.status === 'cancelled') return found;

  const updated = await prisma.$transaction(async (tx) => {
    const r = await tx.reminder.update({
      where: { id: reminderId },
      data: { status: 'cancelled', nextFireAtUtc: null },
    });
    // occurrence ที่ยังไม่ยิง → skipped เพื่อให้ sweeper ไม่หยิบไปยิง
    await tx.reminderOccurrence.updateMany({
      where: { reminderId, status: 'pending' },
      data: { status: 'skipped' },
    });
    return r;
  });

  logger.info({ reminderId, chatId }, 'ยกเลิกการเตือน');
  return updated;
}

/**
 * เปลี่ยนเวลาการเตือนแบบครั้งเดียว
 * ทิ้ง occurrence เดิม (skipped) แล้วสร้างใหม่ — ไม่แก้แถวเดิม
 * เพราะ jobId ของ BullMQ ผูกกับ occurrence id ถ้าแก้เวลาในแถวเดิม
 * job ที่ enqueue ไว้แล้วจะยังยิงตามเวลาเก่า
 */
export async function retimeReminder(
  reminderId: string,
  chatId: string,
  newDueAtUtc: Date,
): Promise<Reminder | null> {
  const found = await prisma.reminder.findFirst({ where: { id: reminderId, chatId } });
  if (!found) return null;

  const updated = await prisma.$transaction(async (tx) => {
    await tx.reminderOccurrence.updateMany({
      where: { reminderId, status: 'pending' },
      data: { status: 'skipped' },
    });

    const r = await tx.reminder.update({
      where: { id: reminderId },
      data: {
        dueAtUtc: newDueAtUtc,
        nextFireAtUtc: newDueAtUtc,
        // ถ้าเคยยกเลิกไว้แล้วเปลี่ยนเวลา = อยากใช้ต่อ
        status: 'active',
      },
    });

    await tx.reminderOccurrence.create({
      data: { reminderId, fireAtUtc: newDueAtUtc, status: 'pending' },
    });

    return r;
  });

  logger.info({ reminderId, chatId, newDueAtUtc }, 'เปลี่ยนเวลาการเตือน');
  return updated;
}

/** รายการเตือนที่ยัง active ของแชทนี้ เรียงตามเวลาที่จะยิงถัดไป */
export async function listActiveReminders(chatId: string, limit = 20): Promise<Reminder[]> {
  return prisma.reminder.findMany({
    where: { chatId, status: 'active' },
    orderBy: [{ nextFireAtUtc: 'asc' }, { createdAt: 'asc' }],
    take: limit,
  });
}


export interface CreateRecurringInput {
  chatId: string;
  createdBy: string;
  title: string;
  note?: string | null;
  /** RFC 5545 ไม่มี DTSTART */
  rrule?: string | null;
  everyMinutes?: number | null;
  /** เวลาที่จะเตือนในแต่ละวัน เป็นนาทีจากเที่ยงคืน (ใช้กับ rrule) */
  fireAtMinuteLocal?: number | null;
  tz: string;
  quietHoursStart?: number | null;
  quietHoursEnd?: number | null;
  now?: Date;
  source?: 'text' | 'image';
  mentionUserIds?: string[];
}

export type CreateRecurringResult =
  | { ok: true; reminder: Reminder; firstFireAtUtc: Date; shiftedByQuietHours: boolean }
  | { ok: false; reason: 'no_rule' | 'bad_rrule' | 'exhausted' };

/**
 * สร้างการเตือนซ้ำ + occurrence รอบแรก
 * ถ้าคำนวณรอบแรกไม่ได้ (rrule พัง) จะไม่บันทึกอะไรเลย
 * ดีกว่าเก็บ reminder ที่ไม่มีวันยิงไว้ให้ผู้ใช้เข้าใจผิดว่าตั้งสำเร็จ
 */
export async function createRecurringReminder(
  input: CreateRecurringInput,
): Promise<CreateRecurringResult> {
  const now = input.now ?? new Date();

  const first = firstOccurrence({
    rrule: input.rrule,
    everyMinutes: input.everyMinutes,
    fireAtMinuteLocal: input.fireAtMinuteLocal,
    tz: input.tz,
    quietHoursStart: input.quietHoursStart,
    quietHoursEnd: input.quietHoursEnd,
    now,
  });

  if (!first.ok) return { ok: false, reason: first.reason };

  const reminder = await prisma.$transaction(async (tx) => {
    const r = await tx.reminder.create({
      data: {
        chatId: input.chatId,
        createdBy: input.createdBy,
        title: input.title,
        note: input.note ?? null,
        kind: 'recurring',
        rrule: input.rrule ?? null,
        everyMinutes: input.everyMinutes ?? null,
        fireAtMinuteLocal: input.fireAtMinuteLocal ?? null,
        nextFireAtUtc: first.fireAtUtc,
        source: input.source ?? 'text',
        mentionUserIds: input.mentionUserIds ?? [],
        status: 'active',
      },
    });

    await tx.reminderOccurrence.create({
      data: {
        reminderId: r.id,
        fireAtUtc: first.fireAtUtc,
        canonicalFireAtUtc: first.canonicalFireAtUtc,
        status: 'pending',
      },
    });

    return r;
  });

  logger.info(
    { reminderId: reminder.id, rrule: input.rrule, everyMinutes: input.everyMinutes, first: first.fireAtUtc },
    'สร้างการเตือนซ้ำ',
  );

  return {
    ok: true,
    reminder,
    firstFireAtUtc: first.fireAtUtc,
    shiftedByQuietHours: first.shiftedByQuietHours,
  };
}

/**
 * สร้าง occurrence รอบถัดไปของการเตือนซ้ำ
 *
 * อ้างจาก canonicalFireAtUtc ของรอบที่เพิ่งยิง ไม่ใช่ fireAtUtc
 * ไม่งั้นการเตือนที่ถูกเลื่อนเพราะ quiet hours จะทำให้ตารางเพี้ยนสะสมทุกวัน
 *
 * ใช้ upsert-by-unique: ถ้ามี occurrence เวลานั้นอยู่แล้ว (sweeper กับ fire worker
 * ทำงานพร้อมกัน) จะไม่สร้างซ้ำและไม่ throw
 */
export async function scheduleNextOccurrence(
  reminder: Reminder,
  justFired: { canonicalFireAtUtc: Date | null; fireAtUtc: Date },
  opts: { tz: string; quietHoursStart?: number | null; quietHoursEnd?: number | null },
): Promise<ReminderOccurrence | null> {
  if (reminder.kind !== 'recurring' || reminder.status !== 'active') return null;

  const anchor = justFired.canonicalFireAtUtc ?? justFired.fireAtUtc;

  // เวลาที่มี occurrence อยู่แล้ว — กันคำนวณได้ค่าซ้ำแล้วชน unique constraint
  const existing = await prisma.reminderOccurrence.findMany({
    where: { reminderId: reminder.id, fireAtUtc: { gte: anchor } },
    select: { fireAtUtc: true },
  });

  const next = nextOccurrence({
    rrule: reminder.rrule,
    everyMinutes: reminder.everyMinutes,
    fireAtMinuteLocal: reminder.fireAtMinuteLocal,
    tz: opts.tz,
    after: anchor,
    quietHoursStart: opts.quietHoursStart,
    quietHoursEnd: opts.quietHoursEnd,
    taken: existing.map((e) => e.fireAtUtc),
  });

  if (!next.ok) {
    logger.error(
      { reminderId: reminder.id, reason: next.reason, rrule: reminder.rrule },
      'คำนวณรอบถัดไปไม่ได้ — หยุดการเตือนนี้',
    );
    await prisma.reminder.update({
      where: { id: reminder.id },
      data: { status: 'done', nextFireAtUtc: null },
    });
    return null;
  }

  try {
    const created = await prisma.$transaction(async (tx) => {
      const occ = await tx.reminderOccurrence.create({
        data: {
          reminderId: reminder.id,
          fireAtUtc: next.fireAtUtc,
          canonicalFireAtUtc: next.canonicalFireAtUtc,
          status: 'pending',
        },
      });
      await tx.reminder.update({
        where: { id: reminder.id },
        data: { nextFireAtUtc: next.fireAtUtc },
      });
      return occ;
    });
    return created;
  } catch (err) {
    // ชน unique (reminderId, fireAtUtc) = มีคนสร้างไปแล้ว ถือว่าสำเร็จ
    logger.debug({ reminderId: reminder.id, err }, 'occurrence รอบถัดไปมีอยู่แล้ว');
    return null;
  }
}

/** ปิดการเตือนถาวรจากปุ่มบน push */
export async function turnOffReminder(
  reminderId: string,
  chatId: string,
): Promise<Reminder | null> {
  return cancelReminder(reminderId, chatId);
}

/**
 * เลื่อนการเตือน (snooze) — สร้าง occurrence ใหม่ที่ชี้กลับไปที่ตัวเดิม
 * ไม่แก้แถวเดิมเพราะแถวเดิมยิงไปแล้ว (status = sent) ต้องเก็บไว้เป็นประวัติ
 */
export async function snoozeOccurrence(
  occurrenceId: string,
  chatId: string,
  minutes: number,
  now: Date = new Date(),
): Promise<{ occurrence: ReminderOccurrence; reminder: Reminder } | null> {
  const occ = await prisma.reminderOccurrence.findFirst({
    where: { id: occurrenceId, reminder: { chatId } },
    include: { reminder: true },
  });
  if (!occ) return null;

  const fireAt = new Date(now.getTime() + minutes * 60_000);

  const created = await prisma.$transaction(async (tx) => {
    const fresh = await tx.reminderOccurrence.create({
      data: {
        reminderId: occ.reminderId,
        fireAtUtc: fireAt,
        canonicalFireAtUtc: occ.canonicalFireAtUtc ?? occ.fireAtUtc,
        status: 'pending',
        snoozedFromId: occ.id,
      },
    });
    // การเตือนครั้งเดียวที่ถูก snooze ต้องกลับมา active
    if (occ.reminder.status !== 'active') {
      await tx.reminder.update({
        where: { id: occ.reminderId },
        data: { status: 'active' },
      });
    }
    return fresh;
  });

  logger.info({ occurrenceId, minutes, fireAt }, 'เลื่อนการเตือน');
  return { occurrence: created, reminder: occ.reminder };
}

/** กดว่าเสร็จแล้ว — การเตือนครั้งเดียวจบเลย ส่วนแบบซ้ำข้ามแค่รอบนี้ */
export async function markOccurrenceDone(
  occurrenceId: string,
  chatId: string,
): Promise<{ reminder: Reminder; wasRecurring: boolean } | null> {
  const occ = await prisma.reminderOccurrence.findFirst({
    where: { id: occurrenceId, reminder: { chatId } },
    include: { reminder: true },
  });
  if (!occ) return null;

  const wasRecurring = occ.reminder.kind === 'recurring';

  if (!wasRecurring) {
    const r = await prisma.reminder.update({
      where: { id: occ.reminderId },
      data: { status: 'done', nextFireAtUtc: null },
    });
    return { reminder: r, wasRecurring };
  }
  // แบบซ้ำ: รอบถัดไปถูกสร้างไว้ตอนยิงแล้ว ไม่ต้องทำอะไรเพิ่ม
  return { reminder: occ.reminder, wasRecurring };
}

export async function getReminderWithChat(reminderId: string) {
  return prisma.reminder.findUnique({
    where: { id: reminderId },
    include: { chat: true },
  });
}
