import { Prisma } from '@prisma/client';
import type { Reminder, ReminderDraft } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import type { ResolvedDraftItem } from '../nlu/imageSchema.js';
import { createOnceReminder, createRecurringReminder } from './service.js';
import { env } from '../config/env.js';

/** draft หมดอายุใน 1 ชม. — ยืนยันช้ากว่านี้ต้องส่งรูปใหม่ (บริบท/เวลาอาจเปลี่ยนไปแล้ว) */
export const DRAFT_TTL_MS = 60 * 60_000;

export interface CreateDraftInput {
  chatId: string;
  createdBy: string;
  items: ResolvedDraftItem[];
  unclearNotes: string[];
}

/** เฉพาะ item ที่คำนวณเวลาสำเร็จ (problem === null) เท่านั้นที่เก็บไว้ให้ยืนยัน */
export function confirmableItems(items: ResolvedDraftItem[]): ResolvedDraftItem[] {
  return items.filter((i) => i.problem === null);
}

export async function createReminderDraft(input: CreateDraftInput): Promise<ReminderDraft> {
  return prisma.reminderDraft.create({
    data: {
      chatId: input.chatId,
      createdBy: input.createdBy,
      source: 'image',
      status: 'pending',
      expiresAt: new Date(Date.now() + DRAFT_TTL_MS),
      // เก็บทั้ง item ที่สำเร็จและพลาดไว้ (payload เป็น JSON เฉยๆ)
      // ตอน confirm จะกรองเอาแต่ที่ problem === null มาสร้างจริง
      payload: {
        items: input.items.map(serializeItem),
        unclearNotes: input.unclearNotes,
      } satisfies Prisma.InputJsonValue,
    },
  });
}

function serializeItem(item: ResolvedDraftItem): Prisma.InputJsonObject {
  return {
    title: item.title,
    kind: item.kind,
    dueAtUtc: item.dueAtUtc?.toISOString() ?? null,
    rrule: item.rrule,
    fireAtMinuteLocal: item.fireAtMinuteLocal,
    confidence: item.confidence,
    problem: item.problem,
  };
}

function deserializeItem(raw: unknown): ResolvedDraftItem {
  const r = raw as Record<string, unknown>;
  return {
    title: String(r['title'] ?? ''),
    kind: r['kind'] === 'recurring' ? 'recurring' : 'once',
    dueAtUtc: typeof r['dueAtUtc'] === 'string' ? new Date(r['dueAtUtc']) : null,
    rrule: typeof r['rrule'] === 'string' ? r['rrule'] : null,
    fireAtMinuteLocal: typeof r['fireAtMinuteLocal'] === 'number' ? r['fireAtMinuteLocal'] : null,
    confidence: typeof r['confidence'] === 'number' ? r['confidence'] : 0,
    problem: typeof r['problem'] === 'string' ? r['problem'] : null,
  };
}

export function readDraftItems(draft: ReminderDraft): {
  items: ResolvedDraftItem[];
  unclearNotes: string[];
} {
  const payload = draft.payload as { items?: unknown[]; unclearNotes?: unknown[] } | null;
  return {
    items: (payload?.items ?? []).map(deserializeItem),
    unclearNotes: (payload?.unclearNotes ?? []).filter((n): n is string => typeof n === 'string'),
  };
}

export type ConfirmDraftResult =
  | { ok: true; created: Reminder[]; skipped: number }
  | { ok: false; reason: 'not_found' | 'expired' | 'already_handled' };

/**
 * ยืนยัน draft → สร้างเตือนจริงทีละรายการ
 *
 * ห้ามยืนยัน draft ซ้ำ (status ต้องเป็น pending เท่านั้น) กันกดปุ่มซ้ำสร้างเตือนซ้ำ
 * ตรวจ chatId ด้วยเสมอ — draftId มาจาก postback ซึ่งเดินทางผ่านเครื่องผู้ใช้ เชื่อไม่ได้ตรงๆ
 */
export async function confirmReminderDraft(
  draftId: string,
  chatId: string,
): Promise<ConfirmDraftResult> {
  const draft = await prisma.reminderDraft.findFirst({ where: { id: draftId, chatId } });
  if (!draft) return { ok: false, reason: 'not_found' };
  if (draft.status !== 'pending') return { ok: false, reason: 'already_handled' };
  if (draft.expiresAt.getTime() < Date.now()) {
    await prisma.reminderDraft.update({ where: { id: draft.id }, data: { status: 'discarded' } });
    return { ok: false, reason: 'expired' };
  }

  // claim แบบ atomic กันกดปุ่มซ้ำพร้อมกัน — เหมือนหลักการ claim ของ scheduler (ดู fire.ts)
  const claimed = await prisma.reminderDraft.updateMany({
    where: { id: draft.id, status: 'pending' },
    data: { status: 'confirmed' },
  });
  if (claimed.count === 0) return { ok: false, reason: 'already_handled' };

  const { items } = readDraftItems(draft);
  const ok = confirmableItems(items);

  const created: Reminder[] = [];
  for (const item of ok) {
    try {
      if (item.kind === 'once' && item.dueAtUtc) {
        const r = await createOnceReminder({
          chatId: draft.chatId,
          createdBy: draft.createdBy,
          title: item.title,
          dueAtUtc: item.dueAtUtc,
          source: 'image',
        });
        created.push(r);
      } else if (item.kind === 'recurring' && item.rrule && item.fireAtMinuteLocal !== null) {
        const user = await prisma.user.findUnique({ where: { lineUserId: draft.createdBy } });
        const out = await createRecurringReminder({
          chatId: draft.chatId,
          createdBy: draft.createdBy,
          title: item.title,
          rrule: item.rrule,
          fireAtMinuteLocal: item.fireAtMinuteLocal,
          tz: user?.tz ?? env.APP_TIMEZONE,
          quietHoursStart: user?.quietHoursStart ?? env.DEFAULT_QUIET_HOURS_START,
          quietHoursEnd: user?.quietHoursEnd ?? env.DEFAULT_QUIET_HOURS_END,
          source: 'image',
        });
        if (out.ok) created.push(out.reminder);
      }
    } catch (err) {
      // รายการเดียวพังไม่ควรทำให้ทั้งชุดหยุด — สร้างที่เหลือต่อ แล้ว log ตัวที่พลาด
      logger.error({ err, title: item.title }, 'สร้างเตือนจาก draft ไม่สำเร็จ (รายการเดียว)');
    }
  }

  logger.info(
    { draftId, chatId, created: created.length, total: items.length },
    'ยืนยัน reminder draft แล้ว',
  );

  return { ok: true, created, skipped: items.length - created.length };
}

export async function discardReminderDraft(draftId: string, chatId: string): Promise<boolean> {
  const out = await prisma.reminderDraft.updateMany({
    where: { id: draftId, chatId, status: 'pending' },
    data: { status: 'discarded' },
  });
  return out.count > 0;
}
