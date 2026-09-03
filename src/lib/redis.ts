import { Redis } from 'ioredis';
import { env } from '../config/env.js';

/**
 * BullMQ บังคับ maxRetriesPerRequest = null
 * และเราแชร์ connection เดียวให้ทั้ง queue (worker จะสร้างของตัวเองแยก)
 */
export function createRedis(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

export const redis = createRedis();
