import type { webhook } from '@line/bot-sdk';
import { logger } from '../lib/logger.js';
import { reply, textMessage } from '../line/reply.js';
import { resolveContext, readSource } from './context.js';
import { deactivateChat, markMemberLeft } from './lifecycle.js';
import { handleMessageEvent } from './message.js';
import { handlePostbackEvent } from './postback.js';

/**
 * ตัวกลางกระจาย event ไปยัง handler ตามชนิด
 * เรียกจาก worker เท่านั้น (ไม่เรียกจาก request cycle ของ webhook)
 */
export async function handleEvent(event: webhook.Event): Promise<void> {
  const log = logger.child({ eventType: event.type });

  // ── event ที่ต้องจัดการก่อน resolveContext เพราะ chat กำลังจะถูกปิด ──
  if (event.type === 'unfollow') {
    const { lineChatId } = readSource(event.source);
    await deactivateChat(lineChatId, 'unfollow');
    return;
  }

  if (event.type === 'leave') {
    const { lineChatId } = readSource(event.source);
    await deactivateChat(lineChatId, 'leave');
    return;
  }

  const ctx = await resolveContext(event);

  switch (event.type) {
    case 'follow': {
      log.info({ chat: ctx.lineChatId }, 'มีคนเพิ่มนามิเป็นเพื่อน');
      if (event.replyToken) {
        await reply(event.replyToken, [textMessage(greetingText(ctx.senderDisplayName))]);
      }
      return;
    }

    case 'join': {
      log.info({ chat: ctx.lineChatId }, 'นามิถูกเชิญเข้ากลุ่ม');
      if (event.replyToken) {
        await reply(event.replyToken, [textMessage(groupGreetingText())]);
      }
      return;
    }

    case 'memberJoined': {
      // ยังไม่รู้ userId ของคนที่เพิ่งเข้ามาจนกว่าเขาจะพูด — resolveContext จะเก็บให้ตอนนั้น
      log.info({ chat: ctx.lineChatId }, 'มีสมาชิกใหม่เข้ากลุ่ม');
      return;
    }

    case 'memberLeft': {
      await markMemberLeft(
        ctx.lineChatId,
        event.left.members.map((m) => m.userId).filter((u): u is string => Boolean(u)),
      );
      return;
    }

    case 'postback': {
      await handlePostbackEvent(event, ctx);
      return;
    }

    case 'message': {
      await handleMessageEvent(event, ctx);
      return;
    }

    default:
      log.debug({ event }, 'ยังไม่รองรับ event ชนิดนี้');
  }
}

function greetingText(name: string | null): string {
  return [
    `สวัสดี${name ? ` คุณ${name}` : ''} เราชื่อนามิ 👋`,
    '',
    'พิมพ์บอกเราได้เลยเหมือนบอกเพื่อน เช่น',
    '• "เตือนกินยาหลังอาหารเย็น 18.00"',
    '• "ทุกวันจันทร์-ศุกร์ 8 โมง เตือนส่งรายงาน"',
    '',
    'ส่งไฟล์หรือลิงก์มาก็เก็บให้ ไม่มีวันหมดอายุ แล้วค้นคืนได้ทีหลัง',
  ].join('\n');
}

function groupGreetingText(): string {
  return [
    'สวัสดีทุกคน เราชื่อนามิ 👋',
    '',
    'ในกลุ่ม เราจะตอบเฉพาะเวลาถูก @นามิ หรือข้อความขึ้นต้นด้วย "นามิ" เท่านั้น',
    'จะได้ไม่รบกวนเวลาคุยกันปกติ',
    '',
    'ลองพิมพ์: "นามิ เตือนทุกวันศุกร์ 5 โมงเย็น ส่งรายงาน"',
  ].join('\n');
}
