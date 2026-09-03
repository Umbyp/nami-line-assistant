import { completeStructured, type LlmOutcome } from '../llm/chat.js';
import { NluResultSchema, type NluResult } from './schema.js';
import { buildSystemPrompt, type PromptContext } from './prompt.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export interface ParseOptions extends PromptContext {
  /** lineId ของแชท ใช้บันทึกต้นทุน */
  scopeId?: string;
}

export type NluOutcome =
  | { ok: true; result: NluResult; costUsd: number }
  /** อ่านไม่ออก/LLM พัง → ต้องตอบผู้ใช้ว่าไม่เข้าใจ ห้ามเดา */
  | { ok: false; reason: string; detail: string; costUsd: number };

export async function parseUserMessage(
  text: string,
  opts: ParseOptions,
): Promise<NluOutcome> {
  const trimmed = text.trim();
  if (trimmed === '') {
    return { ok: false, reason: 'empty_input', detail: 'ข้อความว่าง', costUsd: 0 };
  }

  const out: LlmOutcome<NluResult> = await completeStructured({
    name: 'nami_nlu',
    schema: NluResultSchema,
    system: buildSystemPrompt(opts),
    user: trimmed,
    tier: 'text',
    scopeId: opts.scopeId,
    maxTokens: 1_024,
  });

  if (!out.ok) {
    return { ok: false, reason: out.reason, detail: out.detail, costUsd: out.costUsd };
  }

  const result = sanitizeNluResult(out.data);

  logger.debug(
    {
      intent: result.intent,
      confidence: result.confidence,
      ambiguous: result.ambiguousFields,
      costUsd: out.costUsd,
    },
    'NLU สำเร็จ',
  );

  return { ok: true, result, costUsd: out.costUsd };
}

/**
 * เก็บกวาดผลของโมเดลด้วยกฎที่เรารู้แน่ ก่อนเอาไปตัดสินใจ
 *
 * ambiguousFields ทุกค่า (time/date/title/recurrence/assignee) เป็นเรื่องของ
 * "การตั้งเตือน" เท่านั้น (ดู AmbiguousFieldSchema) แต่โมเดลบางทีใส่ค่ามาแม้ intent
 * จะไม่ใช่ create_reminder เลย — เจอจริงกับ "เดี๋ยวส่งให้นะ https://... เอกสารสัญญา"
 * (intent = save_to_vault) ที่โมเดลใส่ ambiguousFields = ["time"] ทั้งที่ save_to_vault
 * ไม่มีแนวคิดเรื่องเวลาเลย ถ้าไม่กรองออก นามิจะถามคำถามที่ไม่เกี่ยวข้องกับสิ่งที่ผู้ใช้ขอ
 *
 * กรณีที่สอง: "ทุก 30 นาที เตือนพักสายตา" (intent = create_reminder)
 * โมเดลใส่ ambiguousFields = ["time"] ทั้งที่การเตือนแบบ "ทุก N นาที"
 * ไม่ต้องมีเวลาของวันเลย → ถ้าไม่กรองออก นามิจะถามกลับว่า "กี่โมงดี"
 * ซึ่งเป็นคำถามที่ตอบไม่ได้ และผู้ใช้จะตั้งเตือนแบบนี้ไม่ได้เลย
 */
export function sanitizeNluResult(result: NluResult): NluResult {
  const original = result.ambiguousFields;
  let ambiguousFields = original;

  if (result.intent !== 'create_reminder') {
    // ข้ามการสร้าง array ใหม่ถ้าว่างอยู่แล้ว (เก็บ reference เดิมไว้)
    if (original.length > 0) ambiguousFields = [];
  } else if (result.reminder?.everyMinutes && original.includes('time')) {
    ambiguousFields = original.filter((f) => f !== 'time');
  }

  if (ambiguousFields === original) return result;

  return {
    ...result,
    ambiguousFields,
    // ถ้าไม่เหลืออะไรกำกวมแล้ว คำถามที่โมเดลเตรียมไว้ก็ไม่ต้องใช้
    clarifyQuestion: ambiguousFields.length === 0 ? null : result.clarifyQuestion,
  };
}

/**
 * ตัดสินว่าต้องถามผู้ใช้กลับไหม
 *
 * ใช้ 2 สัญญาณ ไม่ใช่แค่ confidence:
 *   1. ambiguousFields ที่โมเดลระบุมาตรงๆ — สัญญาณหลัก
 *   2. confidence ต่ำกว่า threshold — สัญญาณสำรอง
 *
 * เหตุผล: จากการวัดผลจริง confidence ของโมเดลไม่สม่ำเสมอ
 * ข้อความกำกวมเดียวกัน ("เตือนตอนเย็นๆ นะ") รอบหนึ่งได้ 0.5 อีกรอบได้ 0.7
 * ถ้าพึ่งตัวเลขเดียวจะปล่อยของกำกวมผ่านเป็นบางครั้งแล้วเดาเวลาให้ผู้ใช้เอง
 */
export function needsClarification(result: NluResult): boolean {
  if (result.ambiguousFields.length > 0) return true;
  return result.confidence < env.NLU_CONFIDENCE_THRESHOLD;
}

/** คำถามที่จะถามกลับ — ใช้ของโมเดลถ้ามี ไม่มีก็ประกอบจากชื่อ field */
export function clarificationText(result: NluResult): string {
  if (result.clarifyQuestion && result.clarifyQuestion.trim() !== '') {
    return result.clarifyQuestion.trim();
  }

  const labels: Record<string, string> = {
    time: 'กี่โมง',
    date: 'วันไหน',
    title: 'ให้เตือนเรื่องอะไร',
    recurrence: 'ให้เตือนซ้ำแบบไหน',
    assignee: 'ให้เตือนใคร',
  };
  const asked = result.ambiguousFields.map((f) => labels[f] ?? f);

  if (asked.length === 0) return 'นามิยังไม่ค่อยแน่ใจ บอกอีกทีได้ไหม';
  return `ขอถามอีกหน่อย ${asked.join(' และ ')} ดี`;
}
