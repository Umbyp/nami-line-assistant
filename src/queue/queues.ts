import { Queue, type JobsOptions } from 'bullmq';
import { redis } from '../lib/redis.js';

// BullMQ ห้ามใช้ ':' ในชื่อ queue (มันใช้เป็นตัวคั่น redis key เอง)
// การจัด namespace ให้ใช้ option prefix แทน
export const QUEUE_PREFIX = 'nami';

export const QUEUE = {
  /** งานประมวลผล webhook event (NLU, ดาวน์โหลดไฟล์, ตอบกลับ) */
  events: 'events',
  /** งานยิงเตือน 1 occurrence */
  fire: 'reminder-fire',
  /** งานประจำของ scheduler (sweeper/enqueuer) */
  scheduler: 'scheduler',
} as const;

const defaultJobOptions: JobsOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 7 * 24 * 3_600 },
};

export const eventsQueue = new Queue(QUEUE.events, {
  connection: redis,
  prefix: QUEUE_PREFIX,
  defaultJobOptions,
});

export const fireQueue = new Queue(QUEUE.fire, {
  connection: redis,
  prefix: QUEUE_PREFIX,
  defaultJobOptions,
});

export const schedulerQueue = new Queue(QUEUE.scheduler, {
  connection: redis,
  prefix: QUEUE_PREFIX,
  defaultJobOptions: { ...defaultJobOptions, attempts: 1 },
});

export async function closeQueues(): Promise<void> {
  await Promise.allSettled([eventsQueue.close(), fireQueue.close(), schedulerQueue.close()]);
}
