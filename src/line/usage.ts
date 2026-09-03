import { Prisma } from '@prisma/client';
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

/**
 * บันทึกทั้ง token และต้นทุน USD จริง
 * OpenRouter คืน usage.cost มาให้ทุก request → เราไม่ต้องเดาราคาจากตารางราคาเอง
 * ซึ่งสำคัญเพราะราคาต่อโมเดลเปลี่ยนได้ และเราสลับโมเดลตาม tier อยู่แล้ว
 */
export async function recordLlmUsage(
  scopeId: string,
  tokens: number,
  costUsd: number,
): Promise<void> {
  if (tokens <= 0 && costUsd <= 0) return;
  const month = monthKey();
  const cost = new Prisma.Decimal(costUsd);
  await prisma.usageCounter.upsert({
    where: { scopeId_month: { scopeId, month } },
    create: { scopeId, month, llmTokens: tokens, llmCostUsd: cost },
    update: { llmTokens: { increment: tokens }, llmCostUsd: { increment: cost } },
  });
  logCost('llm', scopeId, costUsd);
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

/**
 * log ต้นทุนแยกออกมาเพื่อให้ดึงไปทำ dashboard ได้ง่าย
 * push นับเป็น "จำนวนข้อความ" ส่วน llm นับเป็น "USD"
 */
export function logCost(kind: 'push' | 'llm' | 'storage', scopeId: string, amount: number): void {
  logger.info({ cost: { kind, scopeId, amount } }, 'cost');
}

/** สรุปต้นทุนของเดือนปัจจุบัน ใช้ตอบใน /debug และหน้าตั้งค่าทีหลัง */
export async function getMonthlyUsage(scopeId: string): Promise<{
  month: string;
  pushCount: number;
  llmTokens: number;
  llmCostUsd: string;
  storageBytes: string;
}> {
  const month = monthKey();
  const row = await prisma.usageCounter.findUnique({
    where: { scopeId_month: { scopeId, month } },
  });
  return {
    month,
    pushCount: row?.pushCount ?? 0,
    llmTokens: row?.llmTokens ?? 0,
    llmCostUsd: (row?.llmCostUsd ?? new Prisma.Decimal(0)).toString(),
    storageBytes: (row?.storageBytes ?? 0n).toString(),
  };
}
