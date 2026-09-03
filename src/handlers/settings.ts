import { prisma } from '../lib/prisma.js';
import { env } from '../config/env.js';
import type { User } from '@prisma/client';

export async function getOrCreateUserSettings(userId: string): Promise<User> {
  return prisma.user.upsert({
    where: { lineUserId: userId },
    create: {
      lineUserId: userId,
      tz: env.APP_TIMEZONE,
      quietHoursStart: env.DEFAULT_QUIET_HOURS_START,
      quietHoursEnd: env.DEFAULT_QUIET_HOURS_END,
    },
    update: {},
  });
}

/** ปรับเวลาเริ่ม/สิ้นสุดช่วงเงียบ — ผลกระทบแค่การเตือนซ้ำ (ดู shiftOutOfQuietHours) */
export async function setQuietHour(
  userId: string,
  field: 'start' | 'end',
  minute: number,
): Promise<User> {
  return prisma.user.update({
    where: { lineUserId: userId },
    data: field === 'start' ? { quietHoursStart: minute } : { quietHoursEnd: minute },
  });
}

/** ปิดช่วงเวลาเงียบทั้งหมด — ตั้ง start = end ตามกติกาที่ isInQuietHours ใช้ (ช่วงว่าง = ไม่มี) */
export async function disableQuietHours(userId: string): Promise<User> {
  return prisma.user.update({
    where: { lineUserId: userId },
    data: { quietHoursStart: 0, quietHoursEnd: 0 },
  });
}

/** เปิดช่วงเวลาเงียบกลับมาด้วยค่าดีฟอลต์ (ใช้ตอนผู้ใช้เคยปิดไว้แล้วอยากเปิดใหม่) */
export async function enableDefaultQuietHours(userId: string): Promise<User> {
  return prisma.user.update({
    where: { lineUserId: userId },
    data: {
      quietHoursStart: env.DEFAULT_QUIET_HOURS_START,
      quietHoursEnd: env.DEFAULT_QUIET_HOURS_END,
    },
  });
}
