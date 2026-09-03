import { Worker, type Job } from 'bullmq';
import { QUEUE, QUEUE_PREFIX, schedulerQueue } from '../queue/queues.js';
import { createRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { runSweep } from '../scheduler/enqueue.js';

export const SWEEP_JOB = 'sweep';
export const SWEEP_EVERY_MS = 60_000; // ทุก 1 นาที ตามสเปก

/**
 * ตั้ง repeatable job ของ BullMQ ให้กวาดทุก 1 นาที
 *
 * ใช้ repeatable job ไม่ใช่ setInterval ในโปรเซส เพราะ:
 *   - รอด restart (สถานะอยู่ใน Redis)
 *   - ถ้ามี worker หลายตัว จะมีตัวเดียวที่ได้ทำในแต่ละรอบ (ไม่กวาดซ้อนกัน)
 */
export async function registerSweepSchedule(): Promise<void> {
  await schedulerQueue.add(
    SWEEP_JOB,
    {},
    {
      repeat: { every: SWEEP_EVERY_MS },
      // jobId คงที่ → ตั้งซ้ำกี่รอบก็มี schedule เดียว
      jobId: 'sweep-every-minute',
      removeOnComplete: { count: 20 },
      removeOnFail: { count: 50 },
    },
  );
  logger.info({ everyMs: SWEEP_EVERY_MS }, 'ตั้งตารางกวาด occurrence แล้ว');
}

export function createSchedulerWorker(): Worker {
  const worker = new Worker(
    QUEUE.scheduler,
    async (_job: Job) => {
      const started = Date.now();
      const out = await runSweep(new Date());
      if (out.enqueued > 0 || out.recovered > 0) {
        logger.info({ ...out, ms: Date.now() - started }, 'กวาดเสร็จ');
      }
    },
    {
      connection: createRedis(),
      prefix: QUEUE_PREFIX,
      // กวาดทีละรอบเท่านั้น ไม่ให้ซ้อนกัน
      concurrency: 1,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, err }, 'งานกวาดล้มเหลว');
  });

  return worker;
}
