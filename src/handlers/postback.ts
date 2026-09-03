import type { webhook } from '@line/bot-sdk';
import { DateTime } from 'luxon';
import { logger } from '../lib/logger.js';
import { reply, textMessage } from '../line/reply.js';
import { reminderConfirm } from '../line/flex/reminderConfirm.js';
import { decodePostback } from '../line/postback.js';
import { cancelReminder, retimeReminder } from '../reminders/service.js';
import { env } from '../config/env.js';
import { formatThaiFriendly } from '../lib/time.js';
import { LOCAL_DATETIME_RE } from '../nlu/schema.js';
import type { ChatContext } from './context.js';

export async function handlePostbackEvent(
  event: webhook.PostbackEvent,
  ctx: ChatContext,
): Promise<void> {
  const replyToken = event.replyToken;
  const decoded = decodePostback(event.postback?.data);

  if (!decoded.ok) {
    logger.warn({ detail: decoded.detail }, 'postback อ่านไม่ได้');
    if (replyToken) {
      await reply(replyToken, [textMessage('ปุ่มนี้ใช้ไม่ได้แล้ว ลองตั้งเตือนใหม่นะ')]);
    }
    return;
  }

  const action = decoded.action;
  logger.info({ action: action.a, chat: ctx.lineChatId }, 'postback');

  switch (action.a) {
    case 'rm.cancel': {
      // ส่ง ctx.chat.id ไปด้วยเสมอ — id จาก postback เชื่อไม่ได้ว่าเป็นของแชทนี้
      const r = await cancelReminder(action.id, ctx.chat.id);
      if (!replyToken) return;
      await reply(replyToken, [
        textMessage(r ? `ยกเลิกแล้ว: ${r.title}` : 'ไม่เจอการเตือนนี้ อาจถูกลบไปแล้ว'),
      ]);
      return;
    }

    case 'rm.retime': {
      const picked = event.postback?.params;
      const raw =
        picked && typeof picked === 'object' && 'datetime' in picked
          ? (picked as { datetime?: string }).datetime
          : undefined;

      if (!raw || !LOCAL_DATETIME_RE.test(raw)) {
        logger.warn({ raw }, 'datetimepicker ส่งค่ามาผิดรูป');
        if (replyToken) {
          await reply(replyToken, [textMessage('เลือกเวลาไม่สำเร็จ ลองกดอีกทีนะ')]);
        }
        return;
      }

      // datetimepicker ส่งเวลามาแบบไม่มี timezone — ตีความเป็นเวลาไทย
      const local = DateTime.fromISO(raw, { zone: env.APP_TIMEZONE });
      if (!local.isValid) {
        if (replyToken) await reply(replyToken, [textMessage('เวลาที่เลือกใช้ไม่ได้ ลองอีกทีนะ')]);
        return;
      }

      const newDue = local.toUTC().toJSDate();

      // min ของ picker กันไว้แล้ว แต่เครื่องผู้ใช้อาจเวลาเพี้ยน — เช็คอีกชั้น
      if (newDue.getTime() <= Date.now()) {
        if (replyToken) {
          await reply(replyToken, [textMessage('เวลาที่เลือกผ่านมาแล้ว เลือกเวลาข้างหน้านะ')]);
        }
        return;
      }

      const r = await retimeReminder(action.id, ctx.chat.id, newDue);
      if (!replyToken) return;
      if (!r) {
        await reply(replyToken, [textMessage('ไม่เจอการเตือนนี้ อาจถูกลบไปแล้ว')]);
        return;
      }

      await reply(replyToken, [
        reminderConfirm({
          reminderId: r.id,
          title: r.title,
          note: r.note,
          dueAtUtc: newDue,
        }),
      ]);
      return;
    }

    case 'rm.list': {
      if (replyToken) {
        await reply(replyToken, [textMessage('รายการเตือนแบบมีปุ่มกำลังทำอยู่ 🙏')]);
      }
      return;
    }

    // P3
    case 'rm.done':
    case 'rm.snooze':
    case 'rm.off': {
      if (replyToken) {
        await reply(replyToken, [textMessage('ปุ่มนี้จะใช้ได้ตอนนามิเริ่มยิงเตือนได้ 🙏')]);
      }
      return;
    }

    case 'help': {
      if (replyToken) {
        await reply(replyToken, [textMessage('พิมพ์ "ช่วยเหลือ" ได้เลย นามิจะบอกให้')]);
      }
      return;
    }
  }
}

/** ใช้ใน log/debug: สรุปว่าการเตือนถัดไปคือเมื่อไหร่ */
export function describeNext(dueAtUtc: Date | null): string {
  if (!dueAtUtc) return 'ไม่มี';
  return formatThaiFriendly(dueAtUtc, env.APP_TIMEZONE);
}
