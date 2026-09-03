import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { removePendingJobsForChat } from '../scheduler/enqueue.js';

/**
 * ปิดแชททันทีเมื่อผู้ใช้ block บอท (unfollow) หรือบอทถูกเตะออกจากกลุ่ม (leave)
 *
 * ถ้าไม่ทำ: scheduler จะยิง push เข้าแชทที่ไม่มีใครอยู่ → เสียโควตา push ฟรีๆ
 * และ LINE จะคืน error 403 ทุกครั้ง
 *
 * push() เช็ค is_active ก่อนยิงเสมอ ดังนั้นแค่ปิด flag นี้ก็หยุดการยิงได้ทั้งหมด
 * แต่ลบ delayed job ออกจาก BullMQ ด้วย เพื่อไม่ให้กิน Redis และไม่รบกวน metric
 */
export async function deactivateChat(lineChatId: string, reason: string): Promise<void> {
  const chat = await prisma.chat.findUnique({ where: { lineId: lineChatId } });
  if (!chat) return;

  await prisma.chat.update({
    where: { id: chat.id },
    data: { isActive: false, leftAt: new Date() },
  });

  // ลบ job ที่ตั้งไว้ทิ้ง — ถ้าพลาดก็ไม่เป็นไร push() ยังกันอยู่อีกชั้น
  const removed = await removePendingJobsForChat(chat.id).catch((err) => {
    logger.warn({ err, lineChatId }, 'ลบ job ของแชทที่ปิดไม่สำเร็จ (push จะกันให้อยู่แล้ว)');
    return 0;
  });

  logger.info({ lineChatId, reason, jobsRemoved: removed }, 'ปิดแชทแล้ว — หยุดยิง push');
}

export async function markMemberLeft(chatLineId: string, userIds: string[]): Promise<void> {
  const chat = await prisma.chat.findUnique({ where: { lineId: chatLineId } });
  if (!chat || userIds.length === 0) return;

  // ไม่ลบแถวทิ้ง เพราะยังอยากรู้ว่าใครเคยอยู่ในกลุ่ม (ใช้แสดงชื่อในเตือนเก่า)
  // แค่ปล่อยให้ last_seen_at ค้างไว้ตามเดิม
  logger.info({ chatLineId, userIds }, 'สมาชิกออกจากกลุ่ม');
}
