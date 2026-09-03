import type { Plan } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';

/**
 * โควตาพื้นที่เก็บของ vault
 *
 * ทำไมไม่ใช้ usage_counters.storage_bytes: ตารางนั้น key ด้วย (scope, month)
 * เหมาะกับต้นทุนที่เกิดใหม่ทุกเดือน (push, llm) แต่ vault "ไม่มีวันหมดอายุ"
 * ไฟล์ที่อัปโหลดเดือนที่แล้วยังกินพื้นที่อยู่ ต้องนับสะสมทั้งหมด ไม่ใช่นับต่อเดือน
 * จึงคำนวณจาก SUM ของ vault_items ตรงๆ แทน
 */
export interface VaultQuotaState {
  usedBytes: number;
  limitBytes: number;
  exceeded: boolean;
}

export function storageSoftLimitBytes(plan: Plan): number {
  const mb = plan === 'pro' ? env.STORAGE_SOFT_LIMIT_PRO_MB : env.STORAGE_SOFT_LIMIT_FREE_MB;
  return mb * 1024 * 1024;
}

export async function getVaultQuota(chatId: string, plan: Plan): Promise<VaultQuotaState> {
  const agg = await prisma.vaultItem.aggregate({
    where: { chatId },
    _sum: { sizeBytes: true },
  });
  const usedBytes = agg._sum.sizeBytes ?? 0;
  const limitBytes = storageSoftLimitBytes(plan);
  return { usedBytes, limitBytes, exceeded: usedBytes >= limitBytes };
}
