import { prisma } from '../../src/lib/prisma.js';

export const dbReady = process.env.NAMI_TEST_DB_READY === '1';

/** ล้างตารางให้สะอาดก่อนแต่ละเทสต์ — CASCADE จัดการลำดับ FK ให้ */
export async function resetDb(): Promise<void> {
  await prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      reminder_occurrences, reminder_drafts, reminders,
      vault_items, group_members, chats, users,
      usage_counters, processed_events
    RESTART IDENTITY CASCADE
  `);
}

export async function seedChatAndUser(opts: {
  lineChatId: string;
  lineUserId: string;
  type?: 'user' | 'group';
}): Promise<{ chatId: string }> {
  await prisma.user.create({
    data: { lineUserId: opts.lineUserId, displayName: 'ผู้ทดสอบ', tz: 'Asia/Bangkok' },
  });
  const chat = await prisma.chat.create({
    data: { lineId: opts.lineChatId, type: opts.type ?? 'user', isActive: true },
  });
  return { chatId: chat.id };
}