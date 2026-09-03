import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { createEventWorker } from './eventWorker.js';
import { createFireWorker } from './fireWorker.js';
import { createSchedulerWorker, registerSweepSchedule } from './schedulerWorker.js';
import { closeQueues } from '../queue/queues.js';

/**
 * worker process แยกจาก API process
 * เหตุผล: webhook ต้องตอบ 200 ภายใน ~1 วินาที ห้ามให้งานหนัก (LLM, ดาวน์โหลดไฟล์)
 * มาแย่ง event loop เดียวกัน
 */
async function main(): Promise<void> {
  // ตั้งตารางกวาดก่อนเปิด worker เพื่อให้รอบแรกไม่พลาด
  await registerSweepSchedule();

  const workers = [createEventWorker(), createFireWorker(), createSchedulerWorker()];
  logger.info({ workers: workers.length }, 'worker พร้อมทำงาน');

  const shutdown = async (signal: string): Promise<void> => {
    logger.info({ signal }, 'กำลังปิด worker...');
    // ปิดแบบ graceful: รอ job ที่ทำอยู่ให้จบก่อน
    await Promise.allSettled(workers.map((w) => w.close()));
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'worker เริ่มไม่ได้');
  process.exit(1);
});
