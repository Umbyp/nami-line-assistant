import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { embed, isEmbeddingEnabled, toVectorLiteral } from '../llm/embed.js';
import type { VaultKind } from '@prisma/client';

export interface VaultSearchHit {
  id: string;
  kind: VaultKind;
  title: string | null;
  contentText: string | null;
  storageKey: string | null;
  mime: string | null;
  originalFileName: string | null;
  createdAt: Date;
  score: number;
}

export interface VaultSearchOptions {
  chatId: string;
  query: string;
  limit?: number;
  kind?: VaultKind;
}

/**
 * ค้นหา vault แบบ hybrid: full-text (tsvector) + trigram (ค้น substring ภาษาไทย) + semantic (pgvector)
 *
 * ทำไมต้องผสม 3 แบบ:
 *   PostgreSQL ไม่มี text search config สำหรับภาษาไทย และภาษาไทยไม่เว้นวรรคระหว่างคำ
 *   ดังนั้น to_tsvector('simple', ...) จับได้ดีแค่คำอังกฤษ/ชื่อไฟล์/ตัวเลข
 *   pg_trgm จับ substring ภาษาไทยได้ (ไม่ต้องรู้ขอบเขตคำ) แต่ไม่เข้าใจความหมาย
 *   pgvector เข้าใจความหมาย ("ไฟล์สัญญา" ≈ "เอกสารข้อตกลง") แต่ต้องมี OPENROUTER_API_KEY
 *
 * ถ้าไม่ได้ตั้ง OPENROUTER_API_KEY: ยังค้นได้ด้วย tsvector + trgm เพียงอย่างเดียว (vec_score = 0 เสมอ)
 *
 * ใช้ word_similarity() ไม่ใช่ similarity(): เจอจริงตอนทดสอบ e2e ว่า similarity()
 * เทียบ "ทั้งสตริง" กับ "ทั้งสตริง" จึงถูกเจือจางหนักเมื่อค้นคำสั้นๆ ในเอกสารยาว
 * ("สัญญา" ในข้อความยาว 50 ตัวอักษร ได้ similarity() แค่ 0.07 ต่ำกว่า threshold ทุกกรณี)
 * word_similarity(query, doc) หา substring ที่ตรงที่สุดใน doc แทน จึงได้ 0.6-0.8
 * สำหรับ query สั้นในเอกสารยาว โดยไม่เพิ่ม false positive (คำไม่เกี่ยวข้องยังคงต่ำ)
 *
 * หมายเหตุการ implement: ตำแหน่ง placeholder ($1, $2, ...) คำนวณจากตำแหน่งจริงใน params
 * ไม่ hardcode เลข เพราะเคย hardcode ผิดตอน kind filter ไม่ถูกใช้ (vector เลื่อนตำแหน่งไม่ตรงกัน)
 */
export async function searchVault(opts: VaultSearchOptions): Promise<VaultSearchHit[]> {
  const limit = opts.limit ?? 10;
  const query = opts.query.trim();
  if (query === '') return [];

  let queryVector: string | null = null;
  if (isEmbeddingEnabled()) {
    const out = await embed([query]);
    if (out.ok && out.vectors[0]) {
      queryVector = toVectorLiteral(out.vectors[0]);
    } else if (!out.ok) {
      logger.warn({ reason: out.reason }, 'สร้าง embedding ของคำค้นไม่สำเร็จ — ค้นด้วย full-text/trgm ต่อ');
    }
  }

  // ── สร้าง params ก่อน แล้วค่อยอ้าง index ของแต่ละตัวจากตำแหน่งจริง ──
  const params: unknown[] = [opts.chatId, query, limit];
  const chatIdIdx = 1;
  const queryIdx = 2;
  const limitIdx = 3;

  let kindIdx: number | null = null;
  if (opts.kind) {
    params.push(opts.kind);
    kindIdx = params.length;
  }

  let vecIdx: number | null = null;
  if (queryVector) {
    params.push(queryVector);
    vecIdx = params.length;
  }

  const kindFilter = kindIdx ? `AND kind = $${kindIdx}::"VaultKind"` : '';
  const vecScoreExpr = vecIdx
    ? `CASE WHEN embedding IS NOT NULL THEN GREATEST(1 - (embedding <=> $${vecIdx}::vector), 0) * 3.0 ELSE 0 END`
    : '0';
  const vecWhereExpr = vecIdx
    ? `OR (embedding IS NOT NULL AND (1 - (embedding <=> $${vecIdx}::vector)) > 0.75)`
    : '';

  const rows = await prisma.$queryRawUnsafe<
    Array<{
      id: string;
      kind: VaultKind;
      title: string | null;
      content_text: string | null;
      storage_key: string | null;
      mime: string | null;
      original_file_name: string | null;
      created_at: Date;
      score: number;
    }>
  >(
    `
    SELECT
      id, kind, title, content_text, storage_key, mime, original_file_name, created_at,
      (
        COALESCE(ts_rank(search_tsv, plainto_tsquery('simple', $${queryIdx})), 0) * 2.0
        + GREATEST(
            word_similarity(
              lower($${queryIdx}),
              lower(coalesce(title,'') || ' ' || coalesce(original_file_name,'') || ' ' || coalesce(content_text,''))
            ), 0
          ) * 1.0
        + ${vecScoreExpr}
      ) AS score
    FROM vault_items
    WHERE chat_id = $${chatIdIdx}::uuid
      ${kindFilter}
      AND (
        search_tsv @@ plainto_tsquery('simple', $${queryIdx})
        OR word_similarity(
             lower($${queryIdx}),
             lower(coalesce(title,'') || ' ' || coalesce(original_file_name,'') || ' ' || coalesce(content_text,''))
           ) > 0.35
        ${vecWhereExpr}
      )
    ORDER BY score DESC
    LIMIT $${limitIdx}
    `,
    ...params,
  );

  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    contentText: r.content_text,
    storageKey: r.storage_key,
    mime: r.mime,
    originalFileName: r.original_file_name,
    createdAt: r.created_at,
    score: Number(r.score),
  }));
}
