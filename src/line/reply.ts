import type { messagingApi } from '@line/bot-sdk';
import { lineClient } from './client.js';
import { logger } from '../lib/logger.js';

/**
 * reply ฟรี ใช้ได้เสมอถ้ายังมี replyToken (อายุสั้น ~1 นาที และใช้ได้ครั้งเดียว)
 * ถ้า reply พลาด อย่าโยน error ทิ้งงานทั้ง job — log แล้วให้ caller ตัดสินใจว่าจะ push แทนไหม
 */
export async function reply(
  replyToken: string,
  messages: messagingApi.Message[],
): Promise<boolean> {
  try {
    await lineClient.replyMessage({ replyToken, messages });
    return true;
  } catch (err) {
    logger.error({ err }, 'reply ไม่สำเร็จ');
    return false;
  }
}

export function textMessage(text: string): messagingApi.TextMessage {
  // LINE ตัดข้อความที่เกิน 5000 ตัวอักษร → กันไว้ก่อน
  return { type: 'text', text: text.length > 5000 ? `${text.slice(0, 4997)}...` : text };
}
