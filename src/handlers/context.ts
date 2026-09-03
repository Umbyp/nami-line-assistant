import type { webhook } from '@line/bot-sdk';
import type { Chat, ChatType, User } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { lineClient } from '../line/client.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export interface ChatContext {
  chat: Chat;
  /** lineId ของปลายทาง (userId / groupId / roomId) — ใช้เป็น to ของ push */
  lineChatId: string;
  chatType: ChatType;
  isGroup: boolean;
  /** userId ของคนที่ทำ event นี้ — ไม่มีได้ ถ้าผู้ใช้ปิดการแชร์ profile */
  senderUserId: string | null;
  senderDisplayName: string | null;
}

/** ดึง lineId + ชนิดของแชทจาก event.source */
export function readSource(source: webhook.Source | undefined): {
  lineChatId: string;
  chatType: ChatType;
  senderUserId: string | null;
} {
  if (source?.type === 'group') {
    return { lineChatId: source.groupId, chatType: 'group', senderUserId: source.userId ?? null };
  }
  if (source?.type === 'room') {
    return { lineChatId: source.roomId, chatType: 'room', senderUserId: source.userId ?? null };
  }
  // source เป็น optional ในสเปกใหม่ของ LINE และ userSource.userId ก็ optional
  // (เกิดได้กับ event บางชนิด เช่น standby mode) — โยน error ให้ job fail ไปเลย
  // ดีกว่าเดา chat ผิดตัวแล้วส่งข้อความไปหาคนอื่น
  if (source?.type === 'user' && source.userId) {
    return { lineChatId: source.userId, chatType: 'user', senderUserId: source.userId };
  }
  throw new Error(`event ไม่มี source ที่ระบุแชทได้: ${JSON.stringify(source)}`);
}

/** ดึงชื่อใหม่จาก LINE เมื่อไหร่: ยังไม่มีชื่อ หรือชื่อเก่าเกิน 7 วัน */
const PROFILE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function fetchDisplayName(
  chatType: ChatType,
  lineChatId: string,
  userId: string,
): Promise<string | null> {
  try {
    if (chatType === 'group') {
      // getGroupMemberProfile ใช้ได้แม้ผู้ใช้ไม่ได้เป็นเพื่อนกับบอท
      const p = await lineClient.getGroupMemberProfile(lineChatId, userId);
      return p.displayName ?? null;
    }
    if (chatType === 'room') {
      const p = await lineClient.getRoomMemberProfile(lineChatId, userId);
      return p.displayName ?? null;
    }
    const p = await lineClient.getProfile(userId);
    return p.displayName ?? null;
  } catch (err) {
    // ผู้ใช้อาจปิดการแชร์ profile — ไม่ใช่เรื่องคอขาดบาดตาย
    logger.debug({ err, userId, chatType }, 'ดึง display name ไม่ได้');
    return null;
  }
}

/**
 * upsert chat + user + group_member ให้พร้อมใช้
 *
 * จุดสำคัญ: ทุกครั้งที่มีคนพูดในกลุ่ม เราต้องจำ userId ของเขาไว้
 * เพราะ LINE ไม่ให้ list สมาชิกกลุ่ม (ถ้าไม่ใช่ verified OA)
 * ถ้าไม่เก็บตอนนี้ เราจะ mention (@) คนนั้นไม่ได้เลย
 */
export async function resolveContext(event: webhook.Event): Promise<ChatContext> {
  const { lineChatId, chatType, senderUserId } = readSource(event.source);

  const chat = await prisma.chat.upsert({
    where: { lineId: lineChatId },
    create: { lineId: lineChatId, type: chatType, isActive: true },
    // กลับมา active อีกครั้งถ้าเคย unfollow/leave แล้วกลับมา
    update: { isActive: true, leftAt: null },
  });

  let senderDisplayName: string | null = null;

  if (senderUserId) {
    const existingUser: User | null = await prisma.user.findUnique({
      where: { lineUserId: senderUserId },
    });

    const memberRow =
      chatType === 'user'
        ? null
        : await prisma.groupMember.findUnique({
            where: { chatId_lineUserId: { chatId: chat.id, lineUserId: senderUserId } },
          });

    const cachedName = memberRow?.displayName ?? existingUser?.displayName ?? null;
    const staleAt = memberRow?.lastSeenAt ?? existingUser?.updatedAt ?? null;
    const isStale = !cachedName || !staleAt || Date.now() - staleAt.getTime() > PROFILE_TTL_MS;

    senderDisplayName = isStale
      ? (await fetchDisplayName(chatType, lineChatId, senderUserId)) ?? cachedName
      : cachedName;

    await prisma.user.upsert({
      where: { lineUserId: senderUserId },
      create: {
        lineUserId: senderUserId,
        displayName: senderDisplayName,
        tz: env.APP_TIMEZONE,
        quietHoursStart: env.DEFAULT_QUIET_HOURS_START,
        quietHoursEnd: env.DEFAULT_QUIET_HOURS_END,
      },
      // อย่าเขียนชื่อทับด้วย null ถ้าดึงชื่อใหม่ไม่ได้
      update: senderDisplayName ? { displayName: senderDisplayName } : {},
    });

    if (chatType !== 'user') {
      await prisma.groupMember.upsert({
        where: { chatId_lineUserId: { chatId: chat.id, lineUserId: senderUserId } },
        create: {
          chatId: chat.id,
          lineUserId: senderUserId,
          displayName: senderDisplayName,
          lastSeenAt: new Date(),
        },
        update: {
          lastSeenAt: new Date(),
          ...(senderDisplayName ? { displayName: senderDisplayName } : {}),
        },
      });
    }
  }

  return {
    chat,
    lineChatId,
    chatType,
    isGroup: chatType !== 'user',
    senderUserId,
    senderDisplayName,
  };
}
