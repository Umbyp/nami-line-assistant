import type { messagingApi } from '@line/bot-sdk';

export interface MentionTarget {
  userId: string;
  displayName: string;
}

/**
 * สร้างข้อความ @mention จริงด้วย textV2 + substitution
 *
 * ทำไมต้องแยกจาก Flex: LINE mention (ที่กดแล้วเด้งแจ้งเตือนหาคนนั้นจริงๆ) รองรับ
 * เฉพาะข้อความ (text/textV2) เท่านั้น ข้อความใน Flex bubble เป็นแค่ตัวหนังสือเฉยๆ
 * ต่อให้พิมพ์ "@ชื่อ" ลงไปตรงๆ ก็ไม่ทำงานเป็น mention จริง
 *
 * จึงต้องส่งเป็น "ข้อความ mention" แยกออกมาก่อน แล้วค่อยตามด้วย Flex การ์ดรายละเอียด
 */
export function buildMentionMessage(
  targets: MentionTarget[],
  title: string,
): messagingApi.TextMessageV2 {
  const placeholders = targets.map((_, i) => `{m${i}}`);
  const substitution = Object.fromEntries(
    targets.map((t, i) => [
      `m${i}`,
      { type: 'mention' as const, mentionee: { type: 'user' as const, userId: t.userId } },
    ]),
  );

  return {
    type: 'textV2',
    text: `${placeholders.join(' ')} ⏰ ถึงเวลา${title}แล้วนะคะ`,
    substitution,
  };
}
