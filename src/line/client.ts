import { messagingApi } from '@line/bot-sdk';
import { env } from '../config/env.js';

/**
 * client สำหรับส่งข้อความ (reply/push) และดึงโปรไฟล์
 * reply ฟรี — push มีค่าใช้จ่าย ทุกจุดที่เรียก push ต้องผ่าน src/line/push.ts เพื่อให้นับโควตา
 */
export const lineClient = new messagingApi.MessagingApiClient({
  channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
});

/** client แยกตัวสำหรับดาวน์โหลด content (รูป/ไฟล์) — endpoint ต่างจากตัวส่งข้อความ */
export const lineBlobClient = new messagingApi.MessagingApiBlobClient({
  channelAccessToken: env.LINE_CHANNEL_ACCESS_TOKEN,
});
