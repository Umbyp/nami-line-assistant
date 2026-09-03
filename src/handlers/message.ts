import type { webhook } from '@line/bot-sdk';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { reply, textMessage } from '../line/reply.js';
import { reminderConfirm } from '../line/flex/reminderConfirm.js';
import { gateGroupMessage } from './groupGate.js';
import { parseUserMessage, needsClarification, clarificationText } from '../nlu/parse.js';
import { resolveDueAt } from '../nlu/resolveTime.js';
import { looksRecurring, resolveFireMinute, verifyDueAt } from '../nlu/thaiTime.js';
import { createOnceReminder, createRecurringReminder } from '../reminders/service.js';
import { enqueueDueOccurrences } from '../scheduler/enqueue.js';
import { describeRecurrence } from '../scheduler/nextOccurrence.js';
import { replyWithList } from './postback.js';
import { prisma as db } from '../lib/prisma.js';
import { env } from '../config/env.js';
import { extractUrls } from '../vault/urls.js';
import { saveLinkItem, saveMediaItem, saveTextItem } from '../vault/service.js';
import { searchVault } from '../vault/search.js';
import { vaultSearchResult } from '../line/flex/vaultSearchResult.js';
import { mimeForFileName, mimeForMessageType } from '../vault/mime.js';
import type { ChatContext } from './context.js';
import type { NluResult } from '../nlu/schema.js';

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

  // รูป/ไฟล์: เก็บเข้า vault ทันที (ดาวน์โหลดจาก LINE ก่อนหมดอายุ)
  // ทำในทั้งแชท 1:1 และกลุ่ม แม้ไม่ได้ถูกเรียก — vault ของกลุ่มต้องเก็บของที่ทุกคนส่งไว้
  // แต่ตอบกลับเฉพาะ 1:1 เพื่อไม่ให้กลายเป็นบอทสแปมในกลุ่ม
  if (msg.type === 'image' || msg.type === 'file') {
    await handleMediaMessage(msg, replyToken, ctx);
    return;
  }

  // วิดีโอ/เสียง: ยังไม่เก็บใน v1 (ไม่ได้อยู่ในสเปก vault — text/link/image/file เท่านั้น)
  if (msg.type === 'video' || msg.type === 'audio') {
    logger.debug({ messageType: msg.type }, 'ยังไม่รองรับการเก็บวิดีโอ/เสียง');
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

  // เก็บลิงก์เข้า vault แบบเงียบๆ ไม่ว่าจะถูกเรียกหรือไม่ (ไม่ตอบกลับ)
  // vault ของกลุ่มต้องเก็บของที่ทุกคนส่งไว้ ไม่ใช่แค่ตอนถูกเรียก
  await saveUrlsIfAny(msg.text ?? '', ctx);

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
      await replyWithList(replyToken, ctx);
      return;

    case 'help':
      await reply(replyToken, [textMessage(helpText(ctx.isGroup))]);
      return;

    case 'smalltalk':
      await reply(replyToken, [textMessage('สวัสดีจ้า มีอะไรให้นามิช่วยบอกได้เลย')]);
      return;

    case 'cancel_reminder':
      // ยังแยกไม่ได้ว่าจะยกเลิกอันไหนจากข้อความล้วน → โชว์รายการให้กดลบ
      // ส่งข้อความนำกับรายการไปใน reply เดียว เพราะ replyToken ใช้ได้ครั้งเดียว
      await replyWithList(replyToken, ctx, 'อันไหนดี กดปุ่มลบในรายการได้เลย');
      return;

    case 'search_vault':
      await handleSearchVault(r, replyToken, ctx);
      return;

    case 'save_to_vault':
      await handleSaveToVault(gate.cleanedText, replyToken, ctx);
      return;

    default:
      await reply(replyToken, [
        textMessage('นามิยังไม่เข้าใจว่าต้องการอะไร พิมพ์ "ช่วยเหลือ" ดูตัวอย่างได้'),
      ]);
  }
}

/**
 * ดึงลิงก์ออกจากข้อความแล้วเก็บเข้า vault แบบเงียบๆ (ไม่ตอบกลับ ไม่ throw)
 * ทำแยกจาก NLU เพราะการจับ URL เป็นรูปแบบตายตัว ไม่ต้องเรียก LLM
 */
async function saveUrlsIfAny(text: string, ctx: ChatContext): Promise<string[]> {
  const urls = extractUrls(text);
  if (urls.length === 0 || !ctx.senderUserId) return [];

  const plan = await getUserPlan(ctx.senderUserId);
  for (const url of urls) {
    const out = await saveLinkItem({ chatId: ctx.chat.id, createdBy: ctx.senderUserId, url, plan });
    if (!out.ok) {
      logger.warn({ url, reason: out.reason }, 'เก็บลิงก์เข้า vault ไม่สำเร็จ');
    }
  }
  return urls;
}

async function getUserPlan(userId: string): Promise<'free' | 'pro'> {
  const user = await db.user.findUnique({ where: { lineUserId: userId }, select: { plan: true } });
  return user?.plan ?? 'free';
}

async function handleSearchVault(
  r: NluResult,
  replyToken: string,
  ctx: ChatContext,
): Promise<void> {
  const query = (r.searchQuery ?? '').trim();
  if (query === '') {
    await reply(replyToken, [textMessage('อยากให้หาอะไรดี ลองบอกคำที่จำได้ดู')]);
    return;
  }

  const hits = await searchVault({ chatId: ctx.chat.id, query });
  await reply(replyToken, [vaultSearchResult({ hits, query, tz: env.APP_TIMEZONE })]);
}

async function handleSaveToVault(
  text: string,
  replyToken: string,
  ctx: ChatContext,
): Promise<void> {
  if (!ctx.senderUserId) {
    await reply(replyToken, [textMessage('นามิยังไม่รู้ว่าคุณเป็นใคร ลองเพิ่มนามิเป็นเพื่อนก่อนนะ')]);
    return;
  }

  // ถ้าทั้งข้อความเป็นลิงก์ล้วน saveUrlsIfAny (เรียกไปแล้วก่อนหน้านี้) เก็บให้แล้ว
  // ไม่ต้องเก็บซ้ำเป็น text อีกรายการ
  const urls = extractUrls(text);
  if (urls.length === 1 && urls[0] === text.trim()) {
    await reply(replyToken, [textMessage('เก็บลิงก์ไว้ให้แล้วนะ ค้นหาทีหลังได้เลย')]);
    return;
  }

  const plan = await getUserPlan(ctx.senderUserId);
  const out = await saveTextItem({ chatId: ctx.chat.id, createdBy: ctx.senderUserId, content: text, plan });

  if (!out.ok) {
    await reply(replyToken, [textMessage(vaultFailureText(out))]);
    return;
  }
  await reply(replyToken, [textMessage('จำไว้ให้แล้วนะ ค้นหาทีหลังได้เลย')]);
}

async function handleMediaMessage(
  msg: webhook.ImageMessageContent | webhook.FileMessageContent,
  replyToken: string | undefined,
  ctx: ChatContext,
): Promise<void> {
  if (!ctx.senderUserId) {
    if (replyToken && !ctx.isGroup) {
      await reply(replyToken, [textMessage('นามิยังไม่รู้ว่าคุณเป็นใคร ลองเพิ่มนามิเป็นเพื่อนก่อนนะ')]);
    }
    return;
  }

  const isFile = msg.type === 'file';
  const mime = isFile ? mimeForFileName(msg.fileName) : mimeForMessageType(msg.type);
  const plan = await getUserPlan(ctx.senderUserId);

  const out = await saveMediaItem({
    chatId: ctx.chat.id,
    createdBy: ctx.senderUserId,
    messageId: msg.id,
    kind: isFile ? 'file' : 'image',
    mime,
    originalFileName: isFile ? msg.fileName : null,
    plan,
  });

  // ตอบกลับเฉพาะแชท 1:1 — ในกลุ่มเก็บเงียบๆ กันสแปม (เหมือนกติกาอื่นในกลุ่ม)
  if (!replyToken || ctx.isGroup) return;

  if (out.ok) {
    await reply(replyToken, [
      textMessage(`เก็บ${isFile ? 'ไฟล์' : 'รูป'}ไว้ให้แล้วนะ ค้นหาทีหลังได้เลย`),
    ]);
  } else {
    await reply(replyToken, [textMessage(vaultFailureText(out))]);
  }
}

function vaultFailureText(out: { reason: string; usedBytes?: number; limitBytes?: number }): string {
  if (out.reason === 'quota_exceeded') {
    const usedMb = Math.round((out.usedBytes ?? 0) / 1024 / 1024);
    const limitMb = Math.round((out.limitBytes ?? 0) / 1024 / 1024);
    return `พื้นที่เก็บของเต็มแล้ว (${usedMb}/${limitMb} MB) ลบของเก่าออกก่อนนะ`;
  }
  return 'เก็บของไม่สำเร็จ ลองใหม่อีกทีนะ';
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
    await handleCreateRecurring(draft, replyToken, ctx, originalText);
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
 * สร้างการเตือนซ้ำ
 *
 * quiet hours ใช้ค่าของผู้ตั้งเตือน (ผู้ใช้แต่ละคนตั้งเองได้)
 * ถ้ายังไม่มีในตาราง users ให้ใช้ค่าดีฟอลต์จาก env
 */
async function handleCreateRecurring(
  draft: NonNullable<NluResult['reminder']>,
  replyToken: string,
  ctx: ChatContext,
  originalText: string,
): Promise<void> {
  if (!ctx.senderUserId) {
    await reply(replyToken, [
      textMessage('นามิยังไม่รู้ว่าคุณเป็นใคร ลองเพิ่มนามิเป็นเพื่อนก่อนนะ'),
    ]);
    return;
  }

  // ── หาเวลาที่จะเตือนเอง ไม่เชื่อค่าที่โมเดลให้มา ──
  // โมเดลส่ง "ชั่วโมง" มาแทน "นาทีจากเที่ยงคืน" ซ้ำทุกรอบ (8 โมง → 8 ไม่ใช่ 480)
  // ถ้าเชื่อตรงๆ การเตือนจะไปตกตอน 00:08 แล้วถูกเลื่อนเพราะช่วงเวลาเงียบ
  const fire = draft.everyMinutes
    ? { minute: null, source: 'none' as const, corrected: false }
    : resolveFireMinute({
        text: originalText,
        modelMinute: draft.fireAtMinuteLocal,
        modelDueAtLocal: draft.dueAtLocal,
      });

  if (fire.corrected) {
    logger.warn(
      { text: originalText, modelGave: draft.fireAtMinuteLocal, used: fire.minute, source: fire.source },
      'แก้เวลาเตือนซ้ำที่โมเดลให้มา',
    );
  }

  // ต้องรู้เวลาที่จะเตือนในแต่ละรอบ ไม่งั้นเดาไม่ได้ (ยกเว้นแบบทุก N นาที)
  if (fire.minute == null && !draft.everyMinutes) {
    await reply(replyToken, [textMessage('ให้เตือนกี่โมงดี')]);
    return;
  }

  const user = await db.user.findUnique({ where: { lineUserId: ctx.senderUserId } });

  const out = await createRecurringReminder({
    chatId: ctx.chat.id,
    createdBy: ctx.senderUserId,
    title: draft.title,
    note: draft.note,
    rrule: draft.rrule,
    everyMinutes: draft.everyMinutes,
    fireAtMinuteLocal: fire.minute,
    tz: user?.tz ?? env.APP_TIMEZONE,
    quietHoursStart: user?.quietHoursStart ?? env.DEFAULT_QUIET_HOURS_START,
    quietHoursEnd: user?.quietHoursEnd ?? env.DEFAULT_QUIET_HOURS_END,
    source: 'text',
  });

  if (!out.ok) {
    logger.warn({ reason: out.reason, rrule: draft.rrule }, 'สร้างการเตือนซ้ำไม่สำเร็จ');
    await reply(replyToken, [
      textMessage('นามิยังจับไม่ได้ว่าให้เตือนซ้ำแบบไหน ลองบอกแบบนี้ได้ไหม "ทุกวันจันทร์ 8 โมง"'),
    ]);
    return;
  }

  // รอบแรกอาจอยู่ใน 1 ชม. ข้างหน้า → enqueue ทันที ไม่ต้องรอ sweeper
  await enqueueDueOccurrences().catch((err) =>
    logger.warn({ err }, 'enqueue หลังสร้างการเตือนซ้ำไม่สำเร็จ (sweeper จะเก็บให้)'),
  );

  await reply(replyToken, [
    reminderConfirm({
      reminderId: out.reminder.id,
      title: out.reminder.title,
      note: out.reminder.note,
      dueAtUtc: out.firstFireAtUtc,
      recurrenceLabel: describeRecurrence(draft.rrule, draft.everyMinutes, fire.minute),
      quietHoursShifted: out.shiftedByQuietHours,
      unknownAssignees: ctx.isGroup && draft.assigneeNames.length > 0 ? draft.assigneeNames : [],
    }),
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
    'เตือนซ้ำประจำ',
    '• "ทุกวันจันทร์-ศุกร์ 8 โมง เตือนส่งรายงาน"',
    '• "ทุกวันที่ 25 เตือนจ่ายค่าบัตร"',
    '• "ทุก 30 นาที เตือนพักสายตา"',
    '',
    'ดูรายการ — "มีเตือนอะไรบ้าง" (มีปุ่มแก้เวลา/ลบให้)',
    '',
    'เก็บของไม่มีวันหมดอายุ — ส่งรูป ไฟล์ หรือลิงก์มาได้เลย',
    '• "หาไฟล์สัญญาที่ส่งเมื่อเดือนก่อน"',
    '• "จำไว้ด้วยว่าโค้ดส่วนลดคือ SAVE20"',
    '',
    'กำลังทำอยู่: อ่านรูปตารางเรียน/ใบนัดแล้วตั้งเตือนให้อัตโนมัติ',
  ];
  if (isGroup) {
    lines.push('', 'ในกลุ่ม เรียกนามิด้วย @นามิ หรือขึ้นต้นข้อความด้วย "นามิ" นะ');
  }
  return lines.join('\n');
}
