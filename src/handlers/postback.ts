import type { webhook } from '@line/bot-sdk';
import { DateTime } from 'luxon';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { reply, textMessage } from '../line/reply.js';
import { reminderConfirm } from '../line/flex/reminderConfirm.js';
import { reminderList, LIST_MAX } from '../line/flex/reminderList.js';
import { decodePostback } from '../line/postback.js';
import {
  cancelReminder,
  listActiveReminders,
  markOccurrenceDone,
  retimeReminder,
  snoozeOccurrence,
} from '../reminders/service.js';
import { enqueueDueOccurrences } from '../scheduler/enqueue.js';
import { env } from '../config/env.js';
import { formatThaiFriendly } from '../lib/time.js';
import { LOCAL_DATETIME_RE } from '../nlu/schema.js';
import { getSignedDownloadUrl } from '../vault/storage.js';
import { listRecentVaultItems, toSearchHit } from '../vault/service.js';
import { vaultSearchResult, VAULT_RESULT_MAX } from '../line/flex/vaultSearchResult.js';
import { helpText } from './message.js';
import { settingsView } from '../line/flex/settingsView.js';
import {
  disableQuietHours,
  enableDefaultQuietHours,
  getOrCreateUserSettings,
  setQuietHour,
} from './settings.js';
import { UNKNOWN_SENDER, REMINDER_NOT_FOUND } from '../copy.js';
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
    // ── ยกเลิก / ปิดการเตือน ──
    case 'rm.cancel':
    case 'rm.off': {
      // ส่ง ctx.chat.id ไปเสมอ — id จาก postback เชื่อไม่ได้ว่าเป็นของแชทนี้
      const r = await cancelReminder(action.id, ctx.chat.id);
      if (!replyToken) return;
      await reply(replyToken, [
        textMessage(r ? `ปิดการเตือน "${r.title}" แล้ว ไม่เตือนอีกนะ` : REMINDER_NOT_FOUND),
      ]);
      return;
    }

    // ── เปลี่ยนเวลา (datetimepicker) ──
    case 'rm.retime': {
      const raw = readPickerDatetime(event.postback?.params);

      if (!raw) {
        logger.warn({ params: event.postback?.params }, 'datetimepicker ส่งค่ามาผิดรูป');
        if (replyToken) await reply(replyToken, [textMessage('เลือกเวลาไม่สำเร็จ ลองกดอีกทีนะ')]);
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
        await reply(replyToken, [textMessage(REMINDER_NOT_FOUND)]);
        return;
      }

      // เวลาใหม่อาจอยู่ในช่วง 1 ชม. ข้างหน้า → enqueue ทันที ไม่ต้องรอ sweeper
      await enqueueDueOccurrences().catch((err) =>
        logger.warn({ err }, 'enqueue หลังเปลี่ยนเวลาไม่สำเร็จ (sweeper จะเก็บให้)'),
      );

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

    // ── กดว่าเสร็จแล้ว ──
    case 'rm.done': {
      const out = await markOccurrenceDone(action.oid, ctx.chat.id);
      if (!replyToken) return;
      if (!out) {
        await reply(replyToken, [textMessage(REMINDER_NOT_FOUND)]);
        return;
      }
      await reply(replyToken, [
        textMessage(
          out.wasRecurring
            ? `เก่งมาก 👍 รอบถัดไปนามิจะเตือนอีกนะ`
            : `เยี่ยม 👍 "${out.reminder.title}" เสร็จแล้ว`,
        ),
      ]);
      return;
    }

    // ── เลื่อน ──
    case 'rm.snooze': {
      const out = await snoozeOccurrence(action.oid, ctx.chat.id, action.m);
      if (!replyToken) return;
      if (!out) {
        await reply(replyToken, [textMessage(REMINDER_NOT_FOUND)]);
        return;
      }

      // เวลาที่เลื่อนไปมักอยู่ใน 1 ชม. → enqueue ทันที
      await enqueueDueOccurrences().catch((err) =>
        logger.warn({ err }, 'enqueue หลังเลื่อนไม่สำเร็จ (sweeper จะเก็บให้)'),
      );

      const when = formatThaiFriendly(out.occurrence.fireAtUtc, env.APP_TIMEZONE);
      await reply(replyToken, [textMessage(`เลื่อนไปเตือน ${when} นะ`)]);
      return;
    }

    // ── ดูรายการทั้งหมด ──
    case 'rm.list': {
      if (!replyToken) return;
      await replyWithList(replyToken, ctx);
      return;
    }

    case 'help': {
      if (replyToken) {
        await reply(replyToken, [textMessage(helpText(ctx.isGroup))]);
      }
      return;
    }

    // ── ขอไฟล์/รูปจาก vault กลับมาในแชท ──
    case 'vault.send': {
      if (!replyToken) return;
      const item = await prisma.vaultItem.findFirst({
        where: { id: action.id, chatId: ctx.chat.id },
      });
      if (!item || !item.storageKey) {
        await reply(replyToken, [textMessage('ไม่เจอไฟล์นี้แล้วนะ อาจถูกลบไปแล้ว')]);
        return;
      }

      // ไม่เก็บ URL ถาวรไว้ใน DB — ขอ URL ชั่วคราวตอนที่ต้องใช้จริงเท่านั้น
      const url = await getSignedDownloadUrl(item.storageKey, 600);

      if (item.kind === 'image') {
        await reply(replyToken, [
          { type: 'image', originalContentUrl: url, previewImageUrl: url },
        ]);
      } else {
        // LINE ไม่มี message type สำหรับไฟล์ทั่วไป — ส่งเป็นลิงก์เปิด/ดาวน์โหลดแทน
        // (ลิงก์หมดอายุใน 10 นาที ต่างจากไฟล์ต้นฉบับใน vault ที่ไม่มีวันหมดอายุ)
        await reply(replyToken, [
          textMessage(`${item.title ?? 'ไฟล์'}\nลิงก์เปิด/ดาวน์โหลด (ใช้ได้ 10 นาที):\n${url}`),
        ]);
      }
      return;
    }

    // ── ดูของที่เก็บไว้ล่าสุด (ปุ่มเมนู "โน้ต-ไฟล์") ──
    case 'vault.list': {
      if (!replyToken) return;
      const items = await listRecentVaultItems(ctx.chat.id, VAULT_RESULT_MAX);
      await reply(replyToken, [
        vaultSearchResult({ hits: items.map(toSearchHit), query: '', tz: env.APP_TIMEZONE }),
      ]);
      return;
    }

    // ── ตั้งค่า ──
    case 'settings.view': {
      if (!replyToken) return;
      if (!ctx.senderUserId) {
        await reply(replyToken, [textMessage(UNKNOWN_SENDER)]);
        return;
      }
      const user = await getOrCreateUserSettings(ctx.senderUserId);
      await reply(replyToken, [settingsView(user)]);
      return;
    }

    case 'settings.quiet_start':
    case 'settings.quiet_end': {
      if (!replyToken) return;
      if (!ctx.senderUserId) {
        await reply(replyToken, [textMessage(UNKNOWN_SENDER)]);
        return;
      }
      const minute = readPickerTime(event.postback?.params);
      if (minute === null) {
        logger.warn({ params: event.postback?.params }, 'datetimepicker (time) ส่งค่ามาผิดรูป');
        await reply(replyToken, [textMessage('เลือกเวลาไม่สำเร็จ ลองกดอีกทีนะ')]);
        return;
      }
      const field = action.a === 'settings.quiet_start' ? 'start' : 'end';
      const user = await setQuietHour(ctx.senderUserId, field, minute);
      await reply(replyToken, [settingsView(user)]);
      return;
    }

    case 'settings.quiet_off': {
      if (!replyToken) return;
      if (!ctx.senderUserId) {
        await reply(replyToken, [textMessage(UNKNOWN_SENDER)]);
        return;
      }
      const user = await disableQuietHours(ctx.senderUserId);
      await reply(replyToken, [settingsView(user)]);
      return;
    }

    case 'settings.quiet_on': {
      if (!replyToken) return;
      if (!ctx.senderUserId) {
        await reply(replyToken, [textMessage(UNKNOWN_SENDER)]);
        return;
      }
      const user = await enableDefaultQuietHours(ctx.senderUserId);
      await reply(replyToken, [settingsView(user)]);
      return;
    }
  }
}

/**
 * ใช้ร่วมกับ handler ข้อความ ("ดูการเตือนทั้งหมด")
 *
 * lead ใช้ใส่ข้อความนำหน้า เพราะ replyToken ใช้ได้ครั้งเดียว
 * ถ้าอยากทั้งพูดอะไรและโชว์รายการ ต้องส่งไปในการ reply เดียวกัน
 */
export async function replyWithList(
  replyToken: string,
  ctx: ChatContext,
  lead?: string,
): Promise<void> {
  const total = await prisma.reminder.count({
    where: { chatId: ctx.chat.id, status: 'active' },
  });
  const items = await listActiveReminders(ctx.chat.id, LIST_MAX);

  const messages = [
    ...(lead ? [textMessage(lead)] : []),
    reminderList({ reminders: items, total, tz: env.APP_TIMEZONE }),
  ];

  if (total > LIST_MAX) {
    messages.push(textMessage(`แสดง ${LIST_MAX} รายการแรกจากทั้งหมด ${total} รายการนะ`));
  }

  await reply(replyToken, messages);
}

/**
 * ดึงค่าจาก datetimepicker
 * LINE ส่งมาใน postback.params.datetime เป็น 'YYYY-MM-DDThh:mm' ไม่มี timezone
 */
function readPickerDatetime(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null;
  const v = (params as { datetime?: unknown }).datetime;
  if (typeof v !== 'string' || !LOCAL_DATETIME_RE.test(v)) return null;
  return v;
}

/**
 * ดึงค่าจาก datetimepicker mode='time'
 * LINE ส่งมาใน postback.params.time เป็น 'HH:mm' — แปลงเป็นนาทีจากเที่ยงคืนตรงๆ
 */
function readPickerTime(params: unknown): number | null {
  if (!params || typeof params !== 'object') return null;
  const v = (params as { time?: unknown }).time;
  if (typeof v !== 'string') return null;
  const m = /^(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}
