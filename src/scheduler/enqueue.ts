import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { fireQueue } from '../queue/queues.js';
import { FIRE_JOB, type FireJobData } from '../queue/types.js';
import { recoverStuckOccurrences } from './fire.js';

/** สร้าง delayed job ให้ occurrence ที่จะถึงภายในกี่มิลลิวินาที */
export const ENQUEUE_HORIZON_MS = 60 * 60_000; // 1 ชั่วโมง ตามสเปก

/**
 * ─────────────────────────────────────────────────────────────
 * ทำไมต้องมีทั้ง delayed job และ sweeper
 *
 * delayed job ของ BullMQ แม่นระดับวินาทีและไม่ต้องโพลล์ แต่หายได้
 * (Redis ถูกล้าง, job ถูกลบ, deploy พลาด)
 * sweeper โพลล์ทุก 1 นาที เป็นตาข่ายรองรับ — ช้ากว่าแต่ไม่หาย
 *
 * ทั้งสองทางใช้ jobId = occurrence id เดียวกัน
 * BullMQ ปฏิเสธ job ที่ jobId ซ้ำเงียบๆ จึงไม่มีทางได้สอง job ต่อ occurrence
 * และแม้จะหลุดมาสองตัว fireOccurrence() ก็ claim ได้แค่ตัวเดียว
 * ─────────────────────────────────────────────────────────────
 */
export async function enqueueDueOccurrences(
  now: Date = new Date(),
  horizonMs: number = ENQUEUE_HORIZON_MS,
): Promise<{ enqueued: number; overdue: number }> {
  const horizon = new Date(now.getTime() + horizonMs);

  const due = await prisma.reminderOccurrence.findMany({
    where: {
      status: 'pending',
      fireAtUtc: { lte: horizon },
      reminder: { status: 'active', chat: { isActive: true } },
    },
    select: { id: true, fireAtUtc: true },
    orderBy: { fireAtUtc: 'asc' },
    // กันกรณีคิวยาวผิดปกติ — รอบถัดไปของ sweeper จะเก็บที่เหลือ
    take: 500,
  });

  let enqueued = 0;
  let overdue = 0;

  for (const occ of due) {
    const delay = Math.max(0, occ.fireAtUtc.getTime() - now.getTime());
    if (delay === 0) overdue++;

    try {
      await fireQueue.add(
        FIRE_JOB,
        { occurrenceId: occ.id } satisfies FireJobData,
        {
          // jobId = occurrence id → enqueue ซ้ำกี่รอบก็เป็น job เดียว
          jobId: occ.id,
          delay,
        },
      );
      enqueued++;
    } catch (err) {
      logger.error({ err, occurrenceId: occ.id }, 'enqueue job ยิงเตือนไม่สำเร็จ');
    }
  }

  if (enqueued > 0) {
    logger.debug({ enqueued, overdue, horizonMs }, 'enqueue occurrence ที่ใกล้ถึงเวลา');
  }
  return { enqueued, overdue };
}

/**
 * งานประจำที่ cron เรียกทุก 1 นาที
 *   1. พาแถวที่ค้างในสถานะ sending กลับมา (process ตายกลางทาง)
 *   2. enqueue occurrence ที่จะถึงใน 1 ชม.
 */
export async function runSweep(now: Date = new Date()): Promise<{
  recovered: number;
  enqueued: number;
  overdue: number;
}> {
  const recovered = await recoverStuckOccurrences(5 * 60_000, now);
  const { enqueued, overdue } = await enqueueDueOccurrences(now);
  return { recovered, enqueued, overdue };
}

/**
 * ลบ delayed job ของแชทที่ถูกปิด (unfollow/leave)
 * ไม่ทำก็ไม่ยิงอยู่ดีเพราะ push() เช็ค is_active
 * แต่ลบทิ้งจะได้ไม่กิน Redis และไม่รบกวน metric
 */
export async function removePendingJobsForChat(chatId: string): Promise<number> {
  const pending = await prisma.reminderOccurrence.findMany({
    where: { status: { in: ['pending', 'sending'] }, reminder: { chatId } },
    select: { id: true },
  });

  let removed = 0;
  for (const occ of pending) {
    try {
      const job = await fireQueue.getJob(occ.id);
      if (job) {
        await job.remove();
        removed++;
      }
    } catch (err) {
      logger.debug({ err, occurrenceId: occ.id }, 'ลบ job ไม่สำเร็จ (อาจกำลังทำงานอยู่)');
    }
  }

  if (removed > 0) logger.info({ chatId, removed }, 'ลบ job ยิงเตือนของแชทที่ถูกปิด');
  return removed;
}
