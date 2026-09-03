import type { webhook } from '@line/bot-sdk';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { reply, textMessage } from '../line/reply.js';
import { reminderConfirm } from '../line/flex/reminderConfirm.js';
import { gateGroupMessage } from './groupGate.js';
import { parseUserMessage, needsClarification, clarificationText } from '../nlu/parse.js';
import { resolveDueAt } from '../nlu/resolveTime.js';
import { looksRecurring, verifyDueAt } from '../nlu/thaiTime.js';
import { createOnceReminder, listActiveReminders } from '../reminders/service.js';
import { formatThaiFriendly } from '../lib/time.js';
import { env } from '../config/env.js';
import type { ChatContext } from './context.js';
import type { NluResult } from '../nlu/schema.js';

/** ข้อความที่ใช้ตอบตอนฟีเจอร์ยังไม่เสร็จ — บอกตรงๆ ว่ายังทำไม่ได้ ไม่แกล้งทำ */
const NOT_YET: Record<string, string> = {
  search_vault: 'การค้นของที่เคยส่งไว้ นามิยังทำไม่ได้นะ กำลังทำอยู่ 🙏',
  save_to_vault: 'การเก็บของเข้าคลัง นามิยังทำไม่ได้นะ กำลังทำอยู่ 🙏',
  cancel_reminder:
    'ยกเลิกด้วยการพิมพ์ยังทำไม่ได้ ใช้ปุ่ม [ยกเลิก] ในการ์ดที่นามิส่งให้ตอนตั้งเตือนได้เลย',
};

export async function handleMessageEvent(
  event: webhook.MessageEvent,
  ctx: ChatContext,
): Promise<void> {
  const msg = event.message;
  const replyToken = event.replyToken;

  if (msg.type === 'text') {
    await handleTextMessage(msg, event, ctx);
    return;
  }

  // รูป/ไฟล์: P3 อ่านรูปเป็นเตือน, P4 เก็บเข้า vault
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

async function handleTextMessage(
  msg: webhook.TextMessageContent,
  event: webhook.MessageEvent,
  ctx: ChatContext,
): Promise<void> {
  const gate = gateGroupMessage(msg, ctx.isGroup);
  const replyToken = event.replyToken;

  // ในกลุ่ม: ไม่ได้ถูกเรียก → เงียบ (แต่ resolveContext จำ userId ไว้แล้ว)
  if (!gate.shouldRespond) {
    logger.debug({ chat: ctx.lineChatId }, 'ข้อความในกลุ่มที่ไม่ได้เรียกนามิ — ไม่ตอบ');
    return;
  }
  if (!replyToken) return;

  // ถูกเรียกแต่ไม่มีเนื้อความ (พิมพ์ "นามิ" เฉยๆ)
  if (gate.cleanedText === '') {
    await reply(replyToken, [textMessage('ว่าไงจ๊ะ บอกนามิได้เลย')]);
    return;
  }

  const knownMemberNames = ctx.isGroup ? await memberNames(ctx.chat.id) : undefined;

  const nlu = await parseUserMessage(gate.cleanedText, {
    now: new Date(),
    tz: env.APP_TIMEZONE,
    isGroup: ctx.isGroup,
    knownMemberNames,
    scopeId: ctx.lineChatId,
  });

  // LLM พังหรืออ่านไม่ออก → ถามกลับ ห้ามเดา
  if (!nlu.ok) {
    logger.warn({ reason: nlu.reason, detail: nlu.detail }, 'NLU ใช้ไม่ได้');
    await reply(replyToken, [
      textMessage(
        nlu.reason === 'not_configured'
          ? 'นามิยังต่อสมองไม่ได้ (ยังไม่ได้ตั้ง OPENROUTER_API_KEY)'
          : 'นามิอ่านไม่ออกแฮะ ลองพิมพ์อีกทีได้ไหม เช่น "เตือนกินยา 18.00"',
      ),
    ]);
    return;
  }

  const r = nlu.result;

  // มีอะไรกำกวม → ถามกลับก่อน ไม่บันทึก
  if (needsClarification(r)) {
    logger.info(
      { ambiguous: r.ambiguousFields, confidence: r.confidence },
      'ต้องถามผู้ใช้กลับ',
    );
    await reply(replyToken, [textMessage(clarificationText(r))]);
    return;
  }

  switch (r.intent) {
    case 'create_reminder':
      await handleCreateReminder(r, replyToken, ctx, gate.cleanedText);
      return;

    case 'list_reminders':
      await handleList(replyToken, ctx);
      return;

    case 'help':
      await reply(replyToken, [textMessage(helpText(ctx.isGroup))]);
      return;

    case 'smalltalk':
      await reply(replyToken, [textMessage('สวัสดีจ้า มีอะไรให้นามิช่วยบอกได้เลย')]);
      return;

    case 'search_vault':
    case 'save_to_vault':
    case 'cancel_reminder':
      await reply(replyToken, [textMessage(NOT_YET[r.intent] ?? 'ยังทำไม่ได้นะ')]);
      return;

    default:
      await reply(replyToken, [
        textMessage('นามิยังไม่เข้าใจว่าต้องการอะไร พิมพ์ "ช่วยเหลือ" ดูตัวอย่างได้'),
      ]);
  }
}

async function handleCreateReminder(
  r: NluResult,
  replyToken: string,
  ctx: ChatContext,
  /** ข้อความต้นฉบับ ใช้ตรวจทานเวลาที่โมเดลให้มา */
  originalText: string,
): Promise<void> {
  const draft = r.reminder;
  if (!draft) {
    await reply(replyToken, [textMessage('นามิจับไม่ได้ว่าจะเตือนเรื่องอะไร บอกอีกทีได้ไหม')]);
    return;
  }

  // ── โมเดลบอกว่าซ้ำ แต่ข้อความไม่มีตัวบอกความซ้ำ → ถือว่าครั้งเดียว ──
  // "วันจันทร์ 5 โมงเย็น" โมเดลให้ FREQ=WEEKLY;BYDAY=MO ซ้ำทุกรอบ
  // ถ้าเชื่อโมเดลตรงๆ ผู้ใช้จะถูกปฏิเสธทั้งที่ตั้งเตือนครั้งเดียวได้
  const modelSaysRecurring = draft.kind === 'recurring' || Boolean(draft.rrule) || Boolean(draft.everyMinutes);
  const textSaysRecurring = looksRecurring(originalText);

  if (modelSaysRecurring && !textSaysRecurring && draft.dueAtLocal) {
    logger.info(
      { text: originalText, rrule: draft.rrule },
      'โมเดลบอกว่าซ้ำ แต่ข้อความไม่มีตัวบอกความซ้ำ → ถือว่าครั้งเดียว',
    );
  } else if (modelSaysRecurring) {
    // P3 จะรับ recurring — ตอนนี้บอกตรงๆ ว่ายังไม่ได้ ดีกว่าบันทึกครึ่งๆ กลางๆ
    await reply(replyToken, [
      textMessage('การเตือนซ้ำประจำ นามิยังทำไม่ได้นะ กำลังทำอยู่ 🙏 ตอนนี้ตั้งเตือนครั้งเดียวได้'),
    ]);
    return;
  }

  const due = resolveDueAt(draft.dueAtLocal, draft.dateWasExplicit, {
    now: new Date(),
    tz: env.APP_TIMEZONE,
  });

  if (!due.ok) {
    logger.info({ reason: due.reason, detail: due.detail }, 'แปลงเวลาไม่ได้');
    await reply(replyToken, [textMessage(dueFailureText(due.reason))]);
    return;
  }

  // ── ตรวจทานด้วยกฎภาษาไทยที่คำนวณเองได้ ──
  // โมเดลพลาดตรงส่วนที่เป็นเลข (ดู src/nlu/thaiTime.ts) จึงไม่ปล่อยให้มันตัดสินคนเดียว
  const verified = verifyDueAt({
    text: originalText,
    dueAtUtc: due.dueAtUtc,
    now: new Date(),
    tz: env.APP_TIMEZONE,
  });

  if (verified.corrections.length > 0) {
    // log ไว้เพื่อวัดว่าโมเดลพลาดบ่อยแค่ไหน — ใช้ตัดสินใจว่าควรเปลี่ยนโมเดลไหม
    logger.warn(
      {
        text: originalText,
        modelGave: due.dueAtUtc.toISOString(),
        corrected: verified.dueAtUtc.toISOString(),
        corrections: verified.corrections,
      },
      'แก้เวลาที่โมเดลให้มา',
    );
  }

  if (!ctx.senderUserId) {
    // ไม่รู้ว่าใครสั่ง → createdBy ใส่ไม่ได้ (FK ไป users)
    await reply(replyToken, [
      textMessage('นามิยังไม่รู้ว่าคุณเป็นใคร ลองเพิ่มนามิเป็นเพื่อนก่อนนะ'),
    ]);
    return;
  }

  const reminder = await createOnceReminder({
    chatId: ctx.chat.id,
    createdBy: ctx.senderUserId,
    title: draft.title,
    note: draft.note,
    dueAtUtc: verified.dueAtUtc,
    source: 'text',
  });

  await reply(replyToken, [
    reminderConfirm({
      reminderId: reminder.id,
      title: reminder.title,
      note: reminder.note,
      dueAtUtc: verified.dueAtUtc,
      shiftedDays: due.shiftedDays,
      // P5 จะ map assigneeNames → userId จริง ตอนนี้ยังไม่ mention
      unknownAssignees: ctx.isGroup && draft.assigneeNames.length > 0 ? draft.assigneeNames : [],
    }),
  ]);
}

/**
 * รายการเตือนแบบข้อความล้วน — ของชั่วคราว
 * P3 จะเปลี่ยนเป็น Flex reminderList ที่มีปุ่มแก้/ลบรายตัว
 * ที่ทำไว้เพราะผู้ใช้ที่เพิ่งตั้งเตือนจะถามต่อทันทีว่า "มีเตือนอะไรบ้าง"
 * ตอบว่ายังทำไม่ได้ทั้งที่มีข้อมูลอยู่แล้วมันแย่กว่า
 */
async function handleList(replyToken: string, ctx: ChatContext): Promise<void> {
  const items = await listActiveReminders(ctx.chat.id);
  if (items.length === 0) {
    await reply(replyToken, [textMessage('ยังไม่มีการเตือนที่ตั้งไว้เลย')]);
    return;
  }

  const now = new Date();
  const lines = items.map((r, i) => {
    const when = r.nextFireAtUtc
      ? formatThaiFriendly(r.nextFireAtUtc, env.APP_TIMEZONE, now)
      : 'ยังไม่กำหนด';
    return `${i + 1}. ${r.title} — ${when}`;
  });

  await reply(replyToken, [
    textMessage(
      [`มีการเตือนอยู่ ${items.length} รายการ`, '', ...lines, '', '(ปุ่มแก้/ลบรายตัวกำลังทำอยู่)'].join('\n'),
    ),
  ]);
}

async function memberNames(chatId: string): Promise<string[]> {
  const rows = await prisma.groupMember.findMany({
    where: { chatId, displayName: { not: null } },
    orderBy: { lastSeenAt: 'desc' },
    take: 30,
    select: { displayName: true },
  });
  return rows.map((r) => r.displayName).filter((n): n is string => Boolean(n));
}

function dueFailureText(reason: string): string {
  switch (reason) {
    case 'past_explicit_date':
      return 'วันที่บอกมาผ่านไปแล้วนะ ต้องการวันไหนดี';
    case 'too_far':
      return 'เวลาที่ได้ดูไกลเกินไป ลองบอกวันเวลาอีกทีได้ไหม';
    case 'missing':
      return 'ยังไม่ได้บอกเวลานะ ให้เตือนกี่โมงดี';
    default:
      return 'นามิอ่านเวลาไม่ออกแฮะ ลองบอกแบบนี้ได้ไหม "พรุ่งนี้ 9 โมง" หรือ "18.00"';
  }
}

function helpText(isGroup: boolean): string {
  const lines = [
    'นามิทำอะไรได้บ้าง 👋',
    '',
    'ตั้งเตือน — พิมพ์บอกเหมือนบอกเพื่อน',
    '• "เตือนกินยาหลังอาหารเย็น 18.00"',
    '• "พรุ่งนี้บ่าย 3 ประชุมกับลูกค้า"',
    '• "อีก 2 ชั่วโมงเตือนโทรกลับลูกค้า"',
    '',
    'ดูรายการ — "มีเตือนอะไรบ้าง"',
    '',
    'กำลังทำอยู่: เตือนซ้ำประจำ · อ่านรูปตารางเรียน/ใบนัด · เก็บและค้นไฟล์',
  ];
  if (isGroup) {
    lines.push('', 'ในกลุ่ม เรียกนามิด้วย @นามิ หรือขึ้นต้นข้อความด้วย "นามิ" นะ');
  }
  return lines.join('\n');
}
