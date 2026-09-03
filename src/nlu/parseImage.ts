import { completeStructured } from '../llm/chat.js';
import { ImageExtractionSchema, type ImageExtraction } from './imageSchema.js';
import { buildImagePrompt } from './imagePrompt.js';
import { resolveImageItem } from './resolveImageItem.js';
import type { ResolvedDraftItem } from './imageSchema.js';
import { logger } from '../lib/logger.js';
import { env } from '../config/env.js';

export interface ParseImageOptions {
  now?: Date;
  tz?: string;
  /** lineId ของแชท ใช้บันทึกต้นทุน */
  scopeId?: string;
}

export type ParseImageOutcome =
  | {
      ok: true;
      docType: ImageExtraction['docType'];
      items: ResolvedDraftItem[];
      unclearNotes: string[];
      costUsd: number;
    }
  | { ok: false; reason: string; detail: string; costUsd: number };

/**
 * อ่านรูป (ใบนัด/ตารางเรียน/ตารางเวร) → รายการเตือนที่ตรวจทานเวลาแล้ว
 *
 * ใช้โมเดล tier 'vision' เสมอ (ไม่ใช่ 'text') เพราะวัดผลจริงแล้วว่าโมเดลราคาถูกกว่า
 * อ่านตารางหลายคอลัมน์พลาด (ดู README หัวข้อ "ทำไมต้องใช้ 2 โมเดล")
 */
export async function parseImageForReminders(
  imageBase64: string,
  mime: string,
  opts: ParseImageOptions = {},
): Promise<ParseImageOutcome> {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? env.APP_TIMEZONE;

  const out = await completeStructured({
    name: 'nami_image_reminders',
    schema: ImageExtractionSchema,
    system: buildImagePrompt(now, tz),
    user: [
      { type: 'text', text: 'อ่านรูปนี้แล้วดึงรายการที่ควรตั้งเตือน' },
      { type: 'image', mime, base64: imageBase64 },
    ],
    tier: 'vision',
    scopeId: opts.scopeId,
    maxTokens: 2_048,
  });

  if (!out.ok) {
    return { ok: false, reason: out.reason, detail: out.detail, costUsd: out.costUsd };
  }

  const items = out.data.reminders.map((item) => resolveImageItem(item, { now, tz }));

  logger.debug(
    { docType: out.data.docType, itemCount: items.length, costUsd: out.costUsd },
    'อ่านรูปสำเร็จ',
  );

  return {
    ok: true,
    docType: out.data.docType,
    items,
    unclearNotes: out.data.unclearNotes,
    costUsd: out.costUsd,
  };
}
