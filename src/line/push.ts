import type { messagingApi } from '@line/bot-sdk';
import { lineClient } from './client.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { getPushQuota, incrementPush, logCost } from './usage.js';
import type { Plan } from '@prisma/client';

export interface PushResult {
  sent: boolean;
  reason?: 'inactive_chat' | 'quota_exceeded' | 'api_error';
  error?: unknown;
}

/**
 * ทุกการ push ต้องผ่านฟังก์ชันนี้ — ห้ามเรียก lineClient.pushMessage ตรงๆ ที่อื่น
 * เหตุผล:
 *   1. push มีค่าใช้จ่าย ต้องนับลง usage_counters ทุกครั้ง
 *   2. ต้องเช็ค soft limit ต่อ plan ก่อนยิง
 *   3. ต้องไม่ยิงเข้าแชทที่ผู้ใช้ block/บอทถูกเตะออกจากกลุ่มแล้ว (is_active = false)
 */
export async function push(
  lineChatId: string,
  messages: messagingApi.Message[],
  opts: { plan?: Plan; skipQuotaCheck?: boolean } = {},
): Promise<PushResult> {
  const chat = await prisma.chat.findUnique({ where: { lineId: lineChatId } });

  // แชทถูกปิด (unfollow / บอทออกจากกลุ่ม) → ไม่ยิงทิ้งเปล่าๆ
  if (chat && !chat.isActive) {
    logger.info({ lineChatId }, 'ข้ามการ push เพราะแชทไม่ active');
    return { sent: false, reason: 'inactive_chat' };
  }

  const plan: Plan = opts.plan ?? 'free';

  if (!opts.skipQuotaCheck) {
    const quota = await getPushQuota(lineChatId, plan);
    if (quota.exceeded) {
      logger.warn({ lineChatId, quota }, 'push เกิน soft limit');
      return { sent: false, reason: 'quota_exceeded' };
    }
  }

  try {
    await lineClient.pushMessage({ to: lineChatId, messages });
    await incrementPush(lineChatId, 1);
    logCost('push', lineChatId, 1);
    return { sent: true };
  } catch (err) {
    logger.error({ err, lineChatId }, 'push ไม่สำเร็จ');
    return { sent: false, reason: 'api_error', error: err };
  }
}
