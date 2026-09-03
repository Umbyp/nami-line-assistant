import type { messagingApi } from '@line/bot-sdk';
import { encodePostback } from '../line/postback.js';

/**
 * ชื่อ (name) ของ rich menu — LINE ไม่แสดงให้ผู้ใช้เห็น ใช้แค่หาแถวเก่าตอน setup ซ้ำ
 * เปลี่ยนเลขท้ายทุกครั้งที่แก้ผังปุ่ม เพื่อไม่ให้สคริปต์ setup ไปลบของเก่าที่หน้าตาต่างกันโดยไม่ได้ตั้งใจ
 */
export const RICHMENU_NAME = 'nami-default-v1';

export const RICHMENU_SIZE = { width: 2500, height: 1686 } as const;

/**
 * เมนู 4 ปุ่มตามสเปก: แจ้งเตือน / โน้ต-ไฟล์ / ตั้งค่า / ช่วยเหลือ
 * แบ่งเป็น 2x2 พอดี (1250x843 ต่อช่อง) ตรงกับ assets/richmenu/menu.html
 *
 * ทุกปุ่มเป็น postback ล้วน (ไม่ใช่ message action) เพราะ:
 *   1. ไม่อยากให้มีข้อความ "ปลอม" ของผู้ใช้โผล่ในแชทถ้าไม่ต้องการ (คุมด้วย displayText เอง)
 *   2. ใช้ path เดียวกับปุ่มอื่นในแอป (encodePostback + zod validate ที่ decode)
 */
export function buildRichMenuRequest(): messagingApi.RichMenuRequest {
  const half = { w: RICHMENU_SIZE.width / 2, h: RICHMENU_SIZE.height / 2 };

  return {
    size: RICHMENU_SIZE,
    selected: true,
    name: RICHMENU_NAME,
    chatBarText: 'เมนู',
    areas: [
      {
        bounds: { x: 0, y: 0, width: half.w, height: half.h },
        action: {
          type: 'postback',
          data: encodePostback({ a: 'rm.list' }),
          displayText: 'ดูการเตือนทั้งหมด',
        },
      },
      {
        bounds: { x: half.w, y: 0, width: half.w, height: half.h },
        action: {
          type: 'postback',
          data: encodePostback({ a: 'vault.list' }),
          displayText: 'ดูของที่เก็บไว้',
        },
      },
      {
        bounds: { x: 0, y: half.h, width: half.w, height: half.h },
        action: {
          type: 'postback',
          data: encodePostback({ a: 'settings.view' }),
          displayText: 'ตั้งค่า',
        },
      },
      {
        bounds: { x: half.w, y: half.h, width: half.w, height: half.h },
        action: {
          type: 'postback',
          data: encodePostback({ a: 'help' }),
          displayText: 'ช่วยเหลือ',
        },
      },
    ],
  };
}
