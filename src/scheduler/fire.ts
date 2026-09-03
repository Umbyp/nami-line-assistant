import type { ReminderOccurrence } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { push } from '../line/push.js';
import { reminderFire } from '../line/flex/reminderFire.js';
import { scheduleNextOccurrence } from '../reminders/service.js';
import { env } from '../config/env.js';

export const MAX_FIRE_ATTEMPTS = 3;

export type FireOutcome =
  | { ok: true; skipped?: undefined }
  | { ok: true; skipped: 'already_handled' | 'not_active' | 'chat_inactive' }
  | { ok: false; reason: string; willRetry: boolean };

/**
 * ─────────────────────────────────────────────────────────────
 * ยิงเตือน 1 occurrence
 *
 * ลำดับที่กันยิงซ้ำ:
 *   1. claim  — UPDATE ... WHERE status='pending' แบบ atomic
 *               ถ้าไม่ได้แถว = มีคนอื่นจับไปแล้ว → ออกเงียบๆ
 *   2. push   — ยิงจริง
 *   3. sent   — บันทึกผล + สร้างรอบถัดไปในทรานแซกชัน
 *
 * ทำไมต้อง claim ก่อน: BullMQ job กับ cron sweeper อาจหยิบ occurrence
 * เดียวกันพร้อมกัน การ claim ด้วย UPDATE ... WHERE status ทำให้มีผู้ชนะแค่หนึ่ง
 * (Postgres ล็อกแถวให้เองระหว่าง UPDATE)
 *
 * ทำไมไม่ push ก่อนแล้วค่อย claim: ถ้าตายระหว่างนั้นจะยิงซ้ำ เสียเงินและกวนผู้ใช้
 * ทำไมไม่ mark sent ก่อน push: ถ้าตายระหว่างนั้นการเตือนหายเงียบ กู้ไม่ได้
 * สถานะ sending คือคำตอบ — sweeper พาแถวที่ค้างกลับมาเป็น pending ให้
 * ─────────────────────────────────────────────────────────────
 */
export async function fireOccurrence(occurrenceId: string): Promise<FireOutcome> {
  // ── 1. claim ──
  const claimed = await prisma.reminderOccurrence.updateMany({
    where: { id: occurrenceId, status: 'pending' },
    data: { status: 'sending', claimedAt: new Date(), attempt: { increment: 1 } },
  });

  if (claimed.count === 0) {
    logger.debug({ occurrenceId }, 'occurrence นี้ถูกจับไปแล้ว หรือไม่ได้อยู่สถานะ pending');
    return { ok: true, skipped: 'already_handled' };
  }

  const occ = await prisma.reminderOccurrence.findUnique({
    where: { id: occurrenceId },
    include: { reminder: { include: { chat: true, creator: true } } },
  });

  if (!occ) {
    logger.error({ occurrenceId }, 'claim แล้วแต่หาแถวไม่เจอ');
    return { ok: false, reason: 'occurrence_missing', willRetry: false };
  }

  const { reminder } = occ;
  const chat = reminder.chat;

  // ── การเตือนถูกยกเลิก/แชทถูกปิดระหว่างรอ ──
  if (reminder.status !== 'active') {
    await markSkipped(occ.id, `reminder status = ${reminder.status}`);
    return { ok: true, skipped: 'not_active' };
  }
  if (!chat.isActive) {
    await markSkipped(occ.id, 'chat ไม่ active');
    return { ok: true, skipped: 'chat_inactive' };
  }

  // ── 2. push ──
  const message = reminderFire({
    occurrenceId: occ.id,
    reminderId: reminder.id,
    title: reminder.title,
    note: reminder.note,
    fireAtUtc: occ.fireAtUtc,
    isRecurring: reminder.kind === 'recurring',
    rrule: reminder.rrule,
    everyMinutes: reminder.everyMinutes,
    fireAtMinuteLocal: reminder.fireAtMinuteLocal,
    tz: reminder.creator?.tz ?? env.APP_TIMEZONE,
  });

  const result = await push(chat.lineId, [message], {
    plan: reminder.creator?.plan ?? 'free',
  });

  if (!result.sent) {
    const canRetry = result.reason === 'api_error' && occ.attempt < MAX_FIRE_ATTEMPTS;

    if (result.reason === 'quota_exceeded' || result.reason === 'inactive_chat') {
      // ไม่ใช่ error ชั่วคราว retry ไปก็เท่านั้น
      await markSkipped(occ.id, `push ไม่สำเร็จ: ${result.reason}`);
      logger.warn({ occurrenceId, reason: result.reason }, 'ข้ามการยิง');
      return { ok: true, skipped: 'chat_inactive' };
    }

    await prisma.reminderOccurrence.update({
      where: { id: occ.id },
      data: {
        // ถ้ายัง retry ได้ให้กลับเป็น pending เพื่อให้ job รอบถัดไปหยิบได้
        status: canRetry ? 'pending' : 'failed',
        claimedAt: null,
        lastError: String(result.reason),
      },
    });

    logger.error(
      { occurrenceId, attempt: occ.attempt, reason: result.reason, willRetry: canRetry },
      'ยิงเตือนไม่สำเร็จ',
    );
    return { ok: false, reason: String(result.reason), willRetry: canRetry };
  }

  // ── 3. บันทึกผล + สร้างรอบถัดไป ──
  await prisma.reminderOccurrence.update({
    where: { id: occ.id },
    data: { status: 'sent', sentAt: new Date(), lastError: null },
  });

  if (reminder.kind === 'once') {
    await prisma.reminder.update({
      where: { id: reminder.id },
      data: { status: 'done', nextFireAtUtc: null },
    });
  } else {
    await scheduleNextOccurrence(
      reminder,
      { canonicalFireAtUtc: occ.canonicalFireAtUtc, fireAtUtc: occ.fireAtUtc },
      {
        tz: reminder.creator?.tz ?? env.APP_TIMEZONE,
        quietHoursStart: reminder.creator?.quietHoursStart,
        quietHoursEnd: reminder.creator?.quietHoursEnd,
      },
    );
  }

  logger.info(
    { occurrenceId, reminderId: reminder.id, chat: chat.lineId, kind: reminder.kind },
    'ยิงเตือนสำเร็จ',
  );
  return { ok: true };
}

async function markSkipped(occurrenceId: string, reason: string): Promise<void> {
  await prisma.reminderOccurrence.update({
    where: { id: occurrenceId },
    data: { status: 'skipped', claimedAt: null, lastError: reason },
  });
}

/**
 * พาแถวที่ค้างในสถานะ sending กลับมาเป็น pending
 * เกิดเมื่อ process ตายหลัง claim แต่ก่อน push เสร็จ
 */
export async function recoverStuckOccurrences(
  olderThanMs = 5 * 60_000,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - olderThanMs);

  const stuck = await prisma.reminderOccurrence.updateMany({
    where: { status: 'sending', claimedAt: { lt: cutoff } },
    data: { status: 'pending', claimedAt: null },
  });

  if (stuck.count > 0) {
    logger.warn({ count: stuck.count }, 'พา occurrence ที่ค้างกลับมาเป็น pending');
  }
  return stuck.count;
}

export type { ReminderOccurrence };
