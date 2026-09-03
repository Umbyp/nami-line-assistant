import type { Plan, VaultItem, VaultKind } from '@prisma/client';
import { prisma } from '../lib/prisma.js';
import { logger } from '../lib/logger.js';
import { downloadLineContent } from './download.js';
import { uploadObject, makeStorageKey, deleteObject } from './storage.js';
import { getVaultQuota } from './quota.js';
import { addStorageBytes } from '../line/usage.js';
import { embed, isEmbeddingEnabled, toVectorLiteral } from '../llm/embed.js';

export type SaveResult =
  | { ok: true; item: VaultItem }
  | { ok: false; reason: 'quota_exceeded'; usedBytes: number; limitBytes: number }
  | { ok: false; reason: 'download_failed' | 'upload_failed'; detail: string };

/** เนื้อหาที่ใช้สร้าง embedding — รวมทุกอย่างที่ค้นหาได้ ไม่ใช่แค่ content_text ดิบ */
function embeddingInput(title: string | null, contentText: string | null, tags: string[]): string {
  return [title, contentText, tags.join(' ')].filter(Boolean).join('\n').trim();
}

/**
 * เติม embedding ให้แถวที่เพิ่งสร้าง — แยกออกจากการ insert หลัก
 * เพราะถ้า embedding พัง (โควตา LLM หมด, API ล่ม) ไม่ควรทำให้บันทึกของผู้ใช้ล้มเหลวทั้งหมด
 * full-text (tsvector) + trgm ยังใช้ค้นได้อยู่แม้ embedding จะไม่มี
 */
async function attachEmbedding(item: VaultItem, scopeId: string): Promise<void> {
  if (!isEmbeddingEnabled()) return;

  const text = embeddingInput(item.title, item.contentText, item.tags);
  if (text === '') return;

  const out = await embed([text], scopeId);
  if (!out.ok) {
    logger.warn({ itemId: item.id, reason: out.reason, detail: out.detail }, 'สร้าง embedding ไม่สำเร็จ (ยังค้นด้วย full-text ได้)');
    return;
  }

  const vec = out.vectors[0];
  if (!vec) return;

  // pgvector รับ literal เป็น string ผ่าน raw query เท่านั้น — Prisma Client ยังไม่รองรับ type นี้ตรงๆ
  await prisma.$executeRawUnsafe(
    `UPDATE vault_items SET embedding = $1::vector WHERE id = $2::uuid`,
    toVectorLiteral(vec),
    item.id,
  );
}

export interface SaveTextInput {
  chatId: string;
  createdBy: string;
  content: string;
  title?: string | null;
  tags?: string[];
  plan?: Plan;
}

/** เก็บข้อความล้วน (ไม่ใช่ลิงก์) — ผู้ใช้ขอให้ "จำไว้" หรือ "เก็บไว้ให้ด้วย" */
export async function saveTextItem(input: SaveTextInput): Promise<SaveResult> {
  return saveNonFileItem({
    ...input,
    kind: 'text',
    title: input.title ?? truncateTitle(input.content),
  });
}

export interface SaveLinkInput {
  chatId: string;
  createdBy: string;
  url: string;
  title?: string | null;
  tags?: string[];
  plan?: Plan;
}

/** เก็บลิงก์ — เก็บ URL ไว้ใน content_text ตรงๆ (ไม่ดึงเนื้อหาปลายทางมาเก็บใน v1) */
export async function saveLinkItem(input: SaveLinkInput): Promise<SaveResult> {
  return saveNonFileItem({
    chatId: input.chatId,
    createdBy: input.createdBy,
    content: input.url,
    kind: 'link',
    title: input.title ?? input.url,
    tags: input.tags,
    plan: input.plan,
  });
}

async function saveNonFileItem(input: {
  chatId: string;
  createdBy: string;
  content: string;
  kind: VaultKind;
  title: string | null;
  tags?: string[];
  plan?: Plan;
}): Promise<SaveResult> {
  const quota = await getVaultQuota(input.chatId, input.plan ?? 'free');
  if (quota.exceeded) {
    return { ok: false, reason: 'quota_exceeded', usedBytes: quota.usedBytes, limitBytes: quota.limitBytes };
  }

  const item = await prisma.vaultItem.create({
    data: {
      chatId: input.chatId,
      createdBy: input.createdBy,
      kind: input.kind,
      title: input.title,
      contentText: input.content,
      tags: input.tags ?? [],
    },
  });

  await attachEmbedding(item, input.chatId).catch((err) =>
    logger.error({ err, itemId: item.id }, 'attachEmbedding พังโดยไม่คาดคิด'),
  );

  logger.info({ itemId: item.id, chatId: input.chatId, kind: input.kind }, 'บันทึกลง vault');
  return { ok: true, item };
}

export interface SaveMediaInput {
  chatId: string;
  createdBy: string;
  messageId: string;
  kind: Extract<VaultKind, 'image' | 'file'>;
  mime: string;
  originalFileName?: string | null;
  /** คำบรรยาย/ข้อความประกอบ ถ้ามี (ใช้เป็นตัวช่วยค้นหา) */
  caption?: string | null;
  plan?: Plan;
}

/**
 * ดาวน์โหลดจาก LINE แล้วอัปโหลดเก็บถาวรใน object storage ของเราเอง
 *
 * ต้องทำตั้งแต่ job แรกที่ได้รับ event เพราะไฟล์ใน LINE มีอายุจำกัด
 * ถ้า process ตายกลางทางระหว่างดาวน์โหลด แถวใน DB จะไม่ถูกสร้างเลย (ไม่ insert ก่อน upload)
 * ผู้ใช้จะไม่เห็นรายการที่ดาวน์โหลดไม่สำเร็จ ดีกว่าเห็นรายการที่เปิดไฟล์ไม่ได้
 */
export async function saveMediaItem(input: SaveMediaInput): Promise<SaveResult> {
  const quota = await getVaultQuota(input.chatId, input.plan ?? 'free');
  if (quota.exceeded) {
    return { ok: false, reason: 'quota_exceeded', usedBytes: quota.usedBytes, limitBytes: quota.limitBytes };
  }

  let buffer: Buffer;
  try {
    ({ buffer } = await downloadLineContent(input.messageId));
  } catch (err) {
    logger.error({ err, messageId: input.messageId }, 'ดาวน์โหลดจาก LINE ไม่สำเร็จ');
    return { ok: false, reason: 'download_failed', detail: err instanceof Error ? err.message : String(err) };
  }

  const key = makeStorageKey(input.chatId, input.originalFileName ?? null);

  try {
    await uploadObject(key, buffer, input.mime);
  } catch (err) {
    logger.error({ err, key }, 'อัปโหลดขึ้น storage ไม่สำเร็จ');
    return { ok: false, reason: 'upload_failed', detail: err instanceof Error ? err.message : String(err) };
  }

  const item = await prisma.vaultItem.create({
    data: {
      chatId: input.chatId,
      createdBy: input.createdBy,
      kind: input.kind,
      title: input.originalFileName ?? defaultTitleFor(input.kind),
      contentText: input.caption ?? null,
      storageKey: key,
      mime: input.mime,
      sizeBytes: buffer.length,
      originalFileName: input.originalFileName ?? null,
    },
  });

  await addStorageBytes(input.chatId, buffer.length).catch((err) =>
    logger.error({ err }, 'บันทึกต้นทุน storage ไม่สำเร็จ (ไม่กระทบไฟล์ที่เก็บแล้ว)'),
  );

  await attachEmbedding(item, input.chatId).catch((err) =>
    logger.error({ err, itemId: item.id }, 'attachEmbedding พังโดยไม่คาดคิด'),
  );

  logger.info({ itemId: item.id, chatId: input.chatId, kind: input.kind, bytes: buffer.length }, 'เก็บไฟล์ลง vault');
  return { ok: true, item };
}

function defaultTitleFor(kind: VaultKind): string {
  return kind === 'image' ? 'รูปภาพ' : 'ไฟล์แนบ';
}

function truncateTitle(text: string, max = 60): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

/** ลบรายการ — ต้องเช็คว่าเป็นของแชทนั้นจริง (เผื่อใช้กับปุ่มลบใน P6) */
export async function deleteVaultItem(itemId: string, chatId: string): Promise<boolean> {
  const item = await prisma.vaultItem.findFirst({ where: { id: itemId, chatId } });
  if (!item) return false;

  if (item.storageKey) {
    await deleteObject(item.storageKey).catch((err) =>
      logger.error({ err, key: item.storageKey }, 'ลบไฟล์จาก storage ไม่สำเร็จ (ลบ DB row ต่อ)'),
    );
  }
  await prisma.vaultItem.delete({ where: { id: itemId } });
  return true;
}

/** ของที่เก็บล่าสุด — ใช้กับปุ่มเมนู "โน้ต-ไฟล์" (เรียกดูโดยไม่ต้องพิมพ์ค้นหา) */
export async function listRecentVaultItems(chatId: string, limit = 10): Promise<VaultItem[]> {
  return prisma.vaultItem.findMany({
    where: { chatId },
    orderBy: { createdAt: 'desc' },
    take: limit,
  });
}

/** แปลง VaultItem (จาก listRecentVaultItems) ให้เข้ากับ builder เดียวกับผลค้นหา */
export function toSearchHit(item: VaultItem): {
  id: string;
  kind: VaultKind;
  title: string | null;
  contentText: string | null;
  storageKey: string | null;
  mime: string | null;
  originalFileName: string | null;
  createdAt: Date;
  score: number;
} {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    contentText: item.contentText,
    storageKey: item.storageKey,
    mime: item.mime,
    originalFileName: item.originalFileName,
    createdAt: item.createdAt,
    score: 0,
  };
}

export { getVaultQuota, storageSoftLimitBytes } from './quota.js';
