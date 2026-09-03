import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { monthKey } from '../lib/time.js';
import { logger } from '../lib/logger.js';
import type { Plan } from '@prisma/client';

/**
 * นับต้นทุนตั้งแต่วันแรกตามที่ตกลง
 * scopeId = lineId ของ chat (ปลายทางที่เราจ่ายค่า push จริง)
 */
export async function incrementPush(scopeId: string, count = 1): Promise<void> {
  const month = monthKey();
  await prisma.usageCounter.upsert({
    where: { scopeId_month: { scopeId, month } },
    create: { scopeId, month, pushCount: count },
    update: { pushCount: { increment: count } },
  });
}

export async function incrementLlmTokens(scopeId: string, tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const month = monthKey();
  await prisma.usageCounter.upsert({
    where: { scopeId_month: { scopeId, month } },
    create: { scopeId, month, llmTokens: tokens },
    update: { llmTokens: { increment: tokens } },
  });
}

export async function addStorageBytes(scopeId: string, bytes: number): Promise<void> {
  if (bytes === 0) return;
  const month = monthKey();
  await prisma.usageCounter.upsert({
    where: { scopeId_month: { scopeId, month } },
    create: { scopeId, month, storageBytes: BigInt(bytes) },
    update: { storageBytes: { increment: BigInt(bytes) } },
  });
}

export function pushSoftLimit(plan: Plan): number {
  return plan === 'pro' ? env.PUSH_SOFT_LIMIT_PRO : env.PUSH_SOFT_LIMIT_FREE;
}

export interface QuotaState {
  used: number;
  limit: number;
  exceeded: boolean;
  /** ใช้เกิน 80% แล้ว — ควรเตือนผู้ใช้ */
  nearLimit: boolean;
}

export async function getPushQuota(scopeId: string, plan: Plan): Promise<QuotaState> {
  const month = monthKey();
  const row = await prisma.usageCounter.findUnique({
    where: { scopeId_month: { scopeId, month } },
  });
  const used = row?.pushCount ?? 0;
  const limit = pushSoftLimit(plan);
  return { used, limit, exceeded: used >= limit, nearLimit: used >= limit * 0.8 };
}

/** log ต้นทุนแยกออกมาเพื่อให้ดึงไปทำ dashboard ได้ง่าย */
export function logCost(kind: 'push' | 'llm' | 'storage', scopeId: string, amount: number): void {
  logger.info({ cost: { kind, scopeId, amount } }, 'cost');
}
