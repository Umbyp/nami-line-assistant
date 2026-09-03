import { llm, isLlmConfigured, readCostUsd, readTokens } from './client.js';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { recordLlmUsage } from '../line/usage.js';

export type EmbedOutcome =
  | { ok: true; vectors: number[][]; costUsd: number; tokens: number }
  | { ok: false; reason: 'not_configured' | 'api_error' | 'bad_dimensions'; detail: string };

/**
 * vault semantic search จะทำงานได้ก็ต่อเมื่อมี key
 * ถ้าไม่มี ให้ค้นด้วย full-text + trgm ไปก่อน (ยังใช้งานได้ แค่ semantic หายไป)
 */
export function isEmbeddingEnabled(): boolean {
  return isLlmConfigured();
}

export async function embed(texts: string[], scopeId?: string): Promise<EmbedOutcome> {
  if (!isEmbeddingEnabled()) {
    return { ok: false, reason: 'not_configured', detail: 'ยังไม่ได้ตั้ง OPENROUTER_API_KEY' };
  }
  if (texts.length === 0) return { ok: true, vectors: [], costUsd: 0, tokens: 0 };

  try {
    const res = await llm.embeddings.create({
      model: env.LLM_MODEL_EMBED,
      input: texts,
    });

    // เรียงตาม index ที่ provider คืนมา อย่าเชื่อลำดับใน array เฉยๆ
    const vectors = [...res.data]
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding as unknown as number[]);

    // มิติต้องตรงกับ vector(N) ใน DB ไม่งั้น insert จะพังตอน runtime
    // เจอตรงนี้ดีกว่าไปพังตอนเขียน DB
    const wrong = vectors.find((v) => v.length !== env.EMBEDDING_DIMENSIONS);
    if (wrong) {
      return {
        ok: false,
        reason: 'bad_dimensions',
        detail:
          `โมเดล ${env.LLM_MODEL_EMBED} คืน ${wrong.length} มิติ ` +
          `แต่ EMBEDDING_DIMENSIONS = ${env.EMBEDDING_DIMENSIONS} (ต้องตรงกับ vector(N) ใน migration)`,
      };
    }

    const costUsd = readCostUsd(res.usage);
    const tokens = readTokens(res.usage);
    if (scopeId) {
      await recordLlmUsage(scopeId, tokens, costUsd).catch((err) =>
        logger.error({ err }, 'บันทึกต้นทุน embedding ไม่สำเร็จ'),
      );
    }

    return { ok: true, vectors, costUsd, tokens };
  } catch (err) {
    logger.error({ err, model: env.LLM_MODEL_EMBED }, 'สร้าง embedding ไม่สำเร็จ');
    return { ok: false, reason: 'api_error', detail: err instanceof Error ? err.message : String(err) };
  }
}

/** แปลง number[] → literal ของ pgvector สำหรับใส่ใน raw query */
export function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`;
}
