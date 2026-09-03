import { Worker, type Job } from 'bullmq';
import { QUEUE, QUEUE_PREFIX } from '../queue/queues.js';
import type { FireJobData } from '../queue/types.js';
import { createRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { fireOccurrence, MAX_FIRE_ATTEMPTS } from '../scheduler/fire.js';

export function createFireWorker(): Worker<FireJobData> {
  const worker = new Worker<FireJobData>(
    QUEUE.fire,
    async (job: Job<FireJobData>) => {
      const out = await fireOccurrence(job.data.occurrenceId);

      // โยน error เพื่อให้ BullMQ retry แบบ exponential backoff ตาม defaultJobOptions
      // (ไม่โยนถ้า retry ไปก็ไม่ช่วย เช่นโควตาหมด หรือแชทถูกปิด)
      if (!out.ok && out.willRetry) {
        throw new Error(`ยิงเตือนไม่สำเร็จ: ${out.reason}`);
      }
    },
    {
      connection: createRedis(),
      prefix: QUEUE_PREFIX,
      // การยิงเตือนคุยกับ LINE API — ขนานได้แต่ไม่ต้องมาก
      concurrency: 5,
      lockDuration: 60_000,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(
      { jobId: job?.id, attempt: job?.attemptsMade, max: MAX_FIRE_ATTEMPTS, err },
      'job ยิงเตือนล้มเหลว',
    );
  });

  return worker;
}
