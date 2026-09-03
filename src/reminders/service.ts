import type { Reminder } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';

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
