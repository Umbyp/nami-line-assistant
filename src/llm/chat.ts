import type { ZodType } from 'zod';
import type {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { llm, isLlmConfigured, readCostUsd, readTokens } from './client.js';
import { toStrictJsonSchema } from './jsonSchema.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { recordLlmUsage } from '../line/usage.js';

export type LlmFailure =
  | 'not_configured'
  | 'api_error'
  | 'empty_response'
  | 'invalid_json'
  | 'schema_mismatch';

export type LlmOutcome<T> =
  | { ok: true; data: T; costUsd: number; tokens: number; model: string }
  | { ok: false; reason: LlmFailure; detail: string; costUsd: number; tokens: number };

/** ชิ้นส่วนข้อความ/รูป สำหรับส่งเข้าโมเดลที่อ่านรูปได้ */
export type UserContent =
  | string
  | Array<
      | { type: 'text'; text: string }
      | { type: 'image'; mime: string; base64: string }
    >;

export interface StructuredRequest<T> {
  /** ชื่อ schema ที่ส่งให้ provider (a-z0-9_ เท่านั้น) */
  name: string;
  /** zod schema — เป็นแหล่งความจริงเดียว JSON Schema จะ derive จากตัวนี้ */
  schema: ZodType<T>;
  system: string;
  user: UserContent;
  /** ดีฟอลต์เป็นโมเดลข้อความ ส่ง 'vision' เพื่อใช้โมเดลอ่านรูป */
  tier?: 'text' | 'vision';
  /** override ชื่อโมเดลตรงๆ (ใช้ตอนเทสต์/เปรียบเทียบ) */
  model?: string;
  /** ถ้าใส่มา จะบันทึกต้นทุนลง usage_counters ให้ scope นี้ */
  scopeId?: string;
  maxTokens?: number;
  temperature?: number;
}

function toOpenAiContent(user: UserContent): string | ChatCompletionContentPart[] {
  if (typeof user === 'string') return user;
  return user.map((part) =>
    part.type === 'text'
      ? { type: 'text' as const, text: part.text }
      : {
          type: 'image_url' as const,
          image_url: { url: `data:${part.mime};base64,${part.base64}` },
        },
  );
}

/**
 * เรียก LLM แล้วบังคับให้ผลลัพธ์ตรง zod schema
 *
 * หลักการที่ห้ามละเมิด: ฟังก์ชันนี้ "ไม่ throw" และ "ไม่เดา"
 * ถ้า parse ไม่ได้หรือ schema ไม่ตรง จะคืน ok: false พร้อมเหตุผล
 * ให้ผู้เรียกไปถามผู้ใช้กลับ — ไม่ใช่เติมค่าเดาเอาเอง
 *
 * มี repair pass 1 ครั้ง: ถ้ารอบแรกได้ JSON เสีย จะส่งข้อความเดิม + ข้อผิดพลาดกลับไปให้แก้
 * เกินกว่านั้นไม่คุ้ม ทั้งเวลาและเงิน
 */
export async function completeStructured<T>(req: StructuredRequest<T>): Promise<LlmOutcome<T>> {
  if (!isLlmConfigured()) {
    return {
      ok: false,
      reason: 'not_configured',
      detail: 'ยังไม่ได้ตั้ง OPENROUTER_API_KEY',
      costUsd: 0,
      tokens: 0,
    };
  }

  const model =
    req.model ?? (req.tier === 'vision' ? env.LLM_MODEL_VISION : env.LLM_MODEL_TEXT);
  const jsonSchema = toStrictJsonSchema(req.schema);

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: req.system },
    { role: 'user', content: toOpenAiContent(req.user) },
  ];

  let costUsd = 0;
  let tokens = 0;
  let lastDetail = '';
  let lastReason: LlmFailure = 'api_error';

  // รอบที่ 0 = ปกติ, รอบที่ 1 = repair
  for (let attempt = 0; attempt < 2; attempt++) {
    let content: string | null | undefined;

    try {
      const res = await llm.chat.completions.create({
        model,
        temperature: req.temperature ?? 0,
        max_tokens: req.maxTokens ?? 2_048,
        response_format: {
          type: 'json_schema',
          json_schema: { name: req.name, strict: true, schema: jsonSchema },
        },
        messages,
      });

      costUsd += readCostUsd(res.usage);
      tokens += readTokens(res.usage);
      content = res.choices[0]?.message?.content;
    } catch (err) {
      lastReason = 'api_error';
      lastDetail = err instanceof Error ? err.message : String(err);
      logger.error({ err, model, attempt }, 'เรียก LLM ไม่สำเร็จ');
      break; // error ระดับ API — repair ไม่ช่วย ให้ BullMQ retry ชั้นนอกจัดการ
    }

    if (!content || content.trim() === '') {
      lastReason = 'empty_response';
      lastDetail = 'โมเดลตอบว่างเปล่า';
    } else {
      // บางโมเดลยังห่อ ```json ทั้งที่สั่ง strict — ปอกให้ก่อนเสมอ
      const cleaned = stripCodeFence(content);
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(cleaned);
      } catch {
        lastReason = 'invalid_json';
        lastDetail = `JSON ผิดรูป: ${cleaned.slice(0, 200)}`;
        parsedJson = undefined;
      }

      if (parsedJson !== undefined) {
        const validated = req.schema.safeParse(parsedJson);
        if (validated.success) {
          await maybeRecord(req.scopeId, tokens, costUsd);
          logger.debug({ model, costUsd, tokens, attempt }, 'LLM สำเร็จ');
          return { ok: true, data: validated.data, costUsd, tokens, model };
        }
        lastReason = 'schema_mismatch';
        lastDetail = validated.error.issues
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ');
      }
    }

    if (attempt === 0) {
      logger.warn({ model, reason: lastReason, detail: lastDetail }, 'ผล LLM ใช้ไม่ได้ ลองซ่อมอีกรอบ');
      messages.push(
        { role: 'assistant', content: content ?? '' },
        {
          role: 'user',
          content:
            `ผลลัพธ์ก่อนหน้าใช้ไม่ได้ (${lastReason}): ${lastDetail}\n` +
            'ส่งใหม่เป็น JSON ที่ตรง schema เท่านั้น ห้ามมีข้อความอื่นหรือ code fence',
        },
      );
    }
  }

  await maybeRecord(req.scopeId, tokens, costUsd);
  logger.error({ model, reason: lastReason, detail: lastDetail, costUsd }, 'LLM ใช้ไม่ได้ทั้ง 2 รอบ');
  return { ok: false, reason: lastReason, detail: lastDetail, costUsd, tokens };
}

/** ปอก ```json ... ``` ที่โมเดลบางตัวห่อมาให้ */
export function stripCodeFence(text: string): string {
  const t = text.trim();
  if (!t.startsWith('```')) return t;
  return t
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

async function maybeRecord(scopeId: string | undefined, tokens: number, costUsd: number): Promise<void> {
  if (!scopeId) return;
  // ต้นทุนต้องถูกบันทึกแม้ตอนที่ผลลัพธ์ใช้ไม่ได้ — เราจ่ายเงินไปแล้วจริง
  try {
    await recordLlmUsage(scopeId, tokens, costUsd);
  } catch (err) {
    logger.error({ err, scopeId }, 'บันทึกต้นทุน LLM ไม่สำเร็จ');
  }
}
