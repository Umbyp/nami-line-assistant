import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { dbReady, resetDb } from './helpers/db.js';
import {
  disableQuietHours,
  enableDefaultQuietHours,
  getOrCreateUserSettings,
  setQuietHour,
} from '../src/handlers/settings.js';
import { isInQuietHours } from '../src/lib/time.js';
import { env } from '../src/config/env.js';

const d = dbReady ? describe : describe.skip;
const USER = 'Utest-settings-000000000000000001';

d('settings — ช่วงเวลาเงียบ', () => {
  beforeEach(async () => {
    await resetDb();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('ผู้ใช้ใหม่ได้ค่าดีฟอลต์จาก env', async () => {
    const user = await getOrCreateUserSettings(USER);
    expect(user.quietHoursStart).toBe(env.DEFAULT_QUIET_HOURS_START);
    expect(user.quietHoursEnd).toBe(env.DEFAULT_QUIET_HOURS_END);
    expect(user.tz).toBe(env.APP_TIMEZONE);
  });

  it('เรียกซ้ำกับ user เดิมไม่ทับค่าที่เคยตั้งไว้ (upsert ไม่ reset)', async () => {
    await getOrCreateUserSettings(USER);
    await setQuietHour(USER, 'start', 100);
    const again = await getOrCreateUserSettings(USER);
    expect(again.quietHoursStart).toBe(100);
  });

  it('ปรับเวลาเริ่ม/สิ้นสุดแยกกันได้ ไม่กระทบอีกฝั่ง', async () => {
    await getOrCreateUserSettings(USER);
    await setQuietHour(USER, 'start', 1350);
    const user = await setQuietHour(USER, 'end', 390);
    expect(user.quietHoursStart).toBe(1350);
    expect(user.quietHoursEnd).toBe(390);
  });

  it('ปิดช่วงเวลาเงียบ → isInQuietHours ต้องเป็น false ทุกนาที', async () => {
    await getOrCreateUserSettings(USER);
    const user = await disableQuietHours(USER);
    for (const minute of [0, 600, 1320, 1439]) {
      expect(isInQuietHours(minute, user.quietHoursStart, user.quietHoursEnd)).toBe(false);
    }
  });

  it('เปิดกลับมาด้วยค่าดีฟอลต์หลังจากเคยปิดไว้', async () => {
    await getOrCreateUserSettings(USER);
    await disableQuietHours(USER);
    const user = await enableDefaultQuietHours(USER);
    expect(user.quietHoursStart).toBe(env.DEFAULT_QUIET_HOURS_START);
    expect(user.quietHoursEnd).toBe(env.DEFAULT_QUIET_HOURS_END);
  });

  it('ค่าที่ตั้งใหม่มีผลจริงกับ isInQuietHours', async () => {
    await getOrCreateUserSettings(USER);
    const user = await setQuietHour(USER, 'start', 1200);
    await setQuietHour(USER, 'end', 300);
    const after = await prisma.user.findUniqueOrThrow({ where: { lineUserId: USER } });
    expect(isInQuietHours(1250, after.quietHoursStart, after.quietHoursEnd)).toBe(true);
    expect(isInQuietHours(600, after.quietHoursStart, after.quietHoursEnd)).toBe(false);
    void user;
  });
});
