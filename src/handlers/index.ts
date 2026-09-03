import type { webhook } from '@line/bot-sdk';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { reply, textMessage } from '../line/reply.js';
import { resolveContext, readSource } from './context.js';
import { gateGroupMessage } from './groupGate.js';
import { deactivateChat, markMemberLeft } from './lifecycle.js';

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
      // P3: จะ route ไป src/handlers/postback.ts
      log.info({ data: event.postback.data }, 'postback (ยังไม่ implement)');
      if (event.replyToken) {
        await reply(event.replyToken, [textMessage('ปุ่มนี้ยังทำงานไม่ได้นะ กำลังทำอยู่ 🙏')]);
      }
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

type Ctx = Awaited<ReturnType<typeof resolveContext>>;

async function handleMessageEvent(
  event: webhook.MessageEvent,
  ctx: Ctx,
): Promise<void> {
  const msg = event.message;
  const replyToken = 'replyToken' in event ? event.replyToken : undefined;

  if (msg.type === 'text') {
    const gate = gateGroupMessage(msg, ctx.isGroup);

    // ในกลุ่ม: ไม่ได้ถูกเรียก → เงียบ (แต่ยังจำ userId ไว้แล้วจาก resolveContext)
    if (!gate.shouldRespond) {
      logger.debug({ chat: ctx.lineChatId }, 'ข้อความในกลุ่มที่ไม่ได้เรียกนามิ — ไม่ตอบ');
      return;
    }

    // ── P1: echo กลับไปเพื่อพิสูจน์ว่า pipeline ทั้งเส้นทำงาน ──
    // P2 จะเปลี่ยนบรรทัดนี้เป็นการเรียก NLU
    if (!replyToken) return;

    const memberCount =
      ctx.chatType === 'user'
        ? null
        : await prisma.groupMember.count({ where: { chatId: ctx.chat.id } });

    const lines = [
      `📣 นามิได้ยินแล้ว: "${gate.cleanedText}"`,
      '',
      `แชท: ${ctx.chatType}${memberCount !== null ? ` (จำสมาชิกได้ ${memberCount} คน)` : ''}`,
      `เรียกผ่าน: ${gate.via}`,
      ctx.senderDisplayName ? `จาก: ${ctx.senderDisplayName}` : '',
      '',
      '(นี่คือโหมดทดสอบ P1 — ยังไม่มี NLU)',
    ].filter(Boolean);

    await reply(replyToken, [textMessage(lines.join('\n'))]);
    return;
  }

  // รูป/ไฟล์: P4 จะดาวน์โหลดเก็บ vault, P2-P3 จะอ่านรูปเป็นเตือน
  if (msg.type === 'image' || msg.type === 'file' || msg.type === 'video' || msg.type === 'audio') {
    logger.info({ messageType: msg.type }, 'ได้รับ media (ยังไม่ implement)');
    if (replyToken && !ctx.isGroup) {
      await reply(replyToken, [
        textMessage(`ได้รับ ${msg.type} แล้ว แต่นามิยังเก็บไฟล์ไม่ได้นะ กำลังทำอยู่ 🙏`),
      ]);
    }
    return;
  }

  logger.debug({ messageType: msg.type }, 'ยังไม่รองรับข้อความชนิดนี้');
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
