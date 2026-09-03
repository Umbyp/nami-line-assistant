import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EmbedOutcome } from '../src/llm/embed.js';

/**
 * integration test ของ vault — แตะ Postgres จริง (ทรานแซกชัน, GIN/HNSW index, trigger)
 * mock เฉพาะสิ่งที่ต่อออกนอก process จริงๆ: S3 (MinIO) และ LINE content API
 * ไม่ mock DB เพราะ hybrid search ต้องพิสูจน์ query จริงกับ index จริง
 */
const uploadObject = vi.fn(async (_key: string, _body: Buffer, _mime: string) => undefined);
const deleteObject = vi.fn(async (_key: string) => undefined);
const getSignedDownloadUrl = vi.fn(async (key: string) => `https://signed.example/${key}`);

vi.mock('../src/vault/storage.js', async () => {
  const actual = await vi.importActual<typeof import('../src/vault/storage.js')>(
    '../src/vault/storage.js',
  );
  return { ...actual, uploadObject, deleteObject, getSignedDownloadUrl };
});

const downloadLineContent = vi.fn(async (_messageId: string) => ({
  buffer: Buffer.from('fake-file-bytes'),
  mime: 'application/octet-stream',
}));

vi.mock('../src/vault/download.js', () => ({ downloadLineContent }));

// isEmbeddingEnabled ปิดเป็นดีฟอลต์ในเทสต์ส่วนใหญ่ (ไม่เสียเงินจริง)
// เทสต์ที่ต้องการ embedding จะ mock ค่าคืนของ embed() เป็นรายกรณีไป
//
// ประกาศชนิดตรงๆ ทั้งคู่ (boolean / EmbedOutcome) ไม่งั้น TS จะ infer literal type
// จากค่าเริ่มต้น (false / 'not_configured') แล้วปฏิเสธการ reassign เป็นค่าอื่นในเทสต์ทีหลัง
let embeddingEnabled: boolean = false;
const embedMock = vi.fn<(texts: string[], scopeId?: string) => Promise<EmbedOutcome>>(
  async (_texts, _scopeId) => ({ ok: false, reason: 'not_configured', detail: 'test' }),
);

vi.mock('../src/llm/embed.js', async () => {
  const actual = await vi.importActual<typeof import('../src/llm/embed.js')>('../src/llm/embed.js');
  return {
    ...actual,
    isEmbeddingEnabled: () => embeddingEnabled,
    embed: (...args: Parameters<typeof embedMock>) => embedMock(...args),
  };
});

const { prisma } = await import('../src/lib/prisma.js');
const { dbReady, resetDb, seedChatAndUser } = await import('./helpers/db.js');
const {
  saveTextItem,
  saveLinkItem,
  saveMediaItem,
  deleteVaultItem,
} = await import('../src/vault/service.js');
const { searchVault } = await import('../src/vault/search.js');
const { getVaultQuota, storageSoftLimitBytes } = await import('../src/vault/quota.js');
const { extractUrls } = await import('../src/vault/urls.js');

const d = dbReady ? describe : describe.skip;

const CHAT = 'Utest-vault-000000000000000001';
const USER = 'Utest-vaultuser-00000000000001';
let chatId = '';

beforeEach(async () => {
  await resetDb();
  ({ chatId } = await seedChatAndUser({ lineChatId: CHAT, lineUserId: USER }));
  uploadObject.mockClear();
  deleteObject.mockClear();
  getSignedDownloadUrl.mockClear();
  downloadLineContent.mockClear();
  downloadLineContent.mockResolvedValue({ buffer: Buffer.from('fake-file-bytes'), mime: 'application/octet-stream' });
  embeddingEnabled = false;
  embedMock.mockReset();
  embedMock.mockResolvedValue({ ok: false, reason: 'not_configured', detail: 'test' });
});

afterAll(async () => {
  await prisma.$disconnect();
});

d('vault — บันทึกข้อความ/ลิงก์', () => {
  it('saveTextItem สร้างแถวชนิด text พร้อม title ตัดคำอัตโนมัติ', async () => {
    const long = 'ก'.repeat(100);
    const out = await saveTextItem({ chatId, createdBy: USER, content: long });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item.kind).toBe('text');
    expect(out.item.contentText).toBe(long);
    expect(out.item.title?.length).toBeLessThanOrEqual(60);
    expect(out.item.title?.endsWith('…')).toBe(true);
  });

  it('saveLinkItem เก็บ URL ไว้ใน content_text และ title = URL ถ้าไม่ระบุ', async () => {
    const out = await saveLinkItem({ chatId, createdBy: USER, url: 'https://example.com/doc' });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item.kind).toBe('link');
    expect(out.item.contentText).toBe('https://example.com/doc');
    expect(out.item.title).toBe('https://example.com/doc');
  });

  it('trigger เติม search_tsv ให้อัตโนมัติหลัง insert', async () => {
    const out = await saveTextItem({ chatId, createdBy: USER, content: 'hello world contract' });
    if (!out.ok) return;
    const rows = await prisma.$queryRaw<Array<{ has_tsv: boolean }>>`
      SELECT search_tsv IS NOT NULL AS has_tsv FROM vault_items WHERE id = ${out.item.id}::uuid`;
    expect(rows[0]?.has_tsv).toBe(true);
  });

  it('ไม่พยายามสร้าง embedding ถ้าไม่ได้ตั้ง key (isEmbeddingEnabled = false)', async () => {
    await saveTextItem({ chatId, createdBy: USER, content: 'x' });
    expect(embedMock).not.toHaveBeenCalled();
  });
});

d('vault — โควตาพื้นที่เก็บ (สะสมตลอดกาล ไม่ใช่รายเดือน)', () => {
  it('getVaultQuota รวมขนาดทุกแถวของแชท', async () => {
    await prisma.vaultItem.createMany({
      data: [
        { chatId, createdBy: USER, kind: 'file', sizeBytes: 1000 },
        { chatId, createdBy: USER, kind: 'image', sizeBytes: 2000 },
      ],
    });
    const q = await getVaultQuota(chatId, 'free');
    expect(q.usedBytes).toBe(3000);
    expect(q.exceeded).toBe(false);
  });

  it('เกิน soft limit ของ plan free → exceeded และปฏิเสธการบันทึกใหม่', async () => {
    const limit = storageSoftLimitBytes('free');
    await prisma.vaultItem.create({
      data: { chatId, createdBy: USER, kind: 'file', sizeBytes: limit + 1 },
    });

    const out = await saveTextItem({ chatId, createdBy: USER, content: 'อีกอันหนึ่ง' });
    expect(out.ok).toBe(false);
    if (out.ok || out.reason !== 'quota_exceeded') return;
    expect(out.usedBytes).toBeGreaterThan(out.limitBytes);
  });

  it('plan pro มี limit สูงกว่า free', () => {
    expect(storageSoftLimitBytes('pro')).toBeGreaterThan(storageSoftLimitBytes('free'));
  });

  it('ของเก่าที่อัปโหลดไว้นานแล้วยังนับรวมอยู่ (ไม่หมดอายุ ไม่รีเซ็ตรายเดือน)', async () => {
    const longAgo = new Date('2020-01-01');
    await prisma.vaultItem.create({
      data: { chatId, createdBy: USER, kind: 'file', sizeBytes: 500, createdAt: longAgo },
    });
    const q = await getVaultQuota(chatId, 'free');
    expect(q.usedBytes).toBe(500);
  });
});

d('vault — เก็บไฟล์/รูป (ดาวน์โหลดจาก LINE → อัปโหลดถาวร)', () => {
  it('ดาวน์โหลดสำเร็จ → อัปโหลดและบันทึกแถวพร้อมขนาดไฟล์จริง', async () => {
    downloadLineContent.mockResolvedValue({ buffer: Buffer.from('0123456789'), mime: 'application/pdf' });

    const out = await saveMediaItem({
      chatId, createdBy: USER, messageId: 'm1', kind: 'file',
      mime: 'application/pdf', originalFileName: 'สัญญาเช่า.pdf',
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.item.sizeBytes).toBe(10);
    expect(out.item.mime).toBe('application/pdf');
    expect(out.item.originalFileName).toBe('สัญญาเช่า.pdf');
    expect(out.item.storageKey).toMatch(new RegExp(`^vault/${chatId}/`));
    expect(uploadObject).toHaveBeenCalledTimes(1);
    expect(uploadObject.mock.calls[0]?.[0]).toBe(out.item.storageKey);
  });

  it('บันทึกต้นทุน storage ลง usage_counters', async () => {
    downloadLineContent.mockResolvedValue({ buffer: Buffer.alloc(4096), mime: 'image/jpeg' });
    await saveMediaItem({ chatId, createdBy: USER, messageId: 'm2', kind: 'image', mime: 'image/jpeg' });

    const usage = await prisma.usageCounter.findFirst({ where: { scopeId: chatId } });
    expect(usage?.storageBytes).toBe(4096n);
  });

  it('ดาวน์โหลดจาก LINE ไม่สำเร็จ → ไม่สร้างแถว ไม่อัปโหลด', async () => {
    downloadLineContent.mockRejectedValue(new Error('410 Gone'));

    const out = await saveMediaItem({ chatId, createdBy: USER, messageId: 'm3', kind: 'file', mime: 'application/pdf' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('download_failed');
    expect(uploadObject).not.toHaveBeenCalled();
    expect(await prisma.vaultItem.count({ where: { chatId } })).toBe(0);
  });

  it('อัปโหลดขึ้น storage ไม่สำเร็จ → ไม่สร้างแถวใน DB (กันรายการที่เปิดไฟล์ไม่ได้)', async () => {
    uploadObject.mockRejectedValueOnce(new Error('bucket unreachable'));

    const out = await saveMediaItem({ chatId, createdBy: USER, messageId: 'm4', kind: 'file', mime: 'application/pdf' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('upload_failed');
    expect(await prisma.vaultItem.count({ where: { chatId } })).toBe(0);
  });

  it('พื้นที่เต็ม → ปฏิเสธตั้งแต่ก่อนดาวน์โหลด (ไม่เสียเวลาดาวน์โหลดของที่เก็บไม่ได้)', async () => {
    const limit = storageSoftLimitBytes('free');
    await prisma.vaultItem.create({ data: { chatId, createdBy: USER, kind: 'file', sizeBytes: limit + 1 } });

    const out = await saveMediaItem({ chatId, createdBy: USER, messageId: 'm5', kind: 'file', mime: 'application/pdf' });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('quota_exceeded');
    expect(downloadLineContent).not.toHaveBeenCalled();
  });
});

d('vault — ลบรายการ', () => {
  it('ลบสำเร็จ: ลบทั้งไฟล์ใน storage และแถวใน DB', async () => {
    downloadLineContent.mockResolvedValue({ buffer: Buffer.from('x'), mime: 'application/pdf' });
    const saved = await saveMediaItem({ chatId, createdBy: USER, messageId: 'm6', kind: 'file', mime: 'application/pdf' });
    if (!saved.ok) return;

    const deleted = await deleteVaultItem(saved.item.id, chatId);
    expect(deleted).toBe(true);
    expect(deleteObject).toHaveBeenCalledWith(saved.item.storageKey);
    expect(await prisma.vaultItem.findUnique({ where: { id: saved.item.id } })).toBeNull();
  });

  it('ลบรายการของแชทอื่นต้องไม่สำเร็จ (กัน id เดา)', async () => {
    const out = await saveTextItem({ chatId, createdBy: USER, content: 'ความลับ' });
    if (!out.ok) return;
    const other = await prisma.chat.create({ data: { lineId: 'Cvaultattack-00000000000001', type: 'group' } });

    expect(await deleteVaultItem(out.item.id, other.id)).toBe(false);
    expect(await prisma.vaultItem.findUnique({ where: { id: out.item.id } })).not.toBeNull();
  });

  it('ลบรายการที่ไม่มี storageKey (text/link) ไม่เรียก deleteObject', async () => {
    const out = await saveTextItem({ chatId, createdBy: USER, content: 'แค่ข้อความ' });
    if (!out.ok) return;
    await deleteVaultItem(out.item.id, chatId);
    expect(deleteObject).not.toHaveBeenCalled();
  });
});

d('vault — ค้นหาแบบ hybrid (full-text + trgm)', () => {
  beforeEach(async () => {
    await saveTextItem({ chatId, createdBy: USER, content: 'ไฟล์สัญญาลูกค้าเดือนที่แล้ว' });
    await saveLinkItem({ chatId, createdBy: USER, url: 'https://docs.google.com/doc123', title: 'Google Docs ของทีม' });
    await saveTextItem({ chatId, createdBy: USER, content: 'ตารางเวรพยาบาล กันยายน' });
    await prisma.vaultItem.create({
      data: { chatId, createdBy: USER, kind: 'file', title: 'ใบเสนอราคา.pdf', storageKey: 'vault/x/1.pdf', sizeBytes: 100 },
    });
  });

  it('เจอคำไทยที่เป็น substring ของคำยาวกว่า (ผ่าน trgm ไม่ใช่ tsvector)', async () => {
    const hits = await searchVault({ chatId, query: 'สัญญา' });
    expect(hits.map((h) => h.contentText)).toContain('ไฟล์สัญญาลูกค้าเดือนที่แล้ว');
  });

  it('เจอคำอังกฤษผ่าน full-text', async () => {
    const hits = await searchVault({ chatId, query: 'google' });
    expect(hits.some((h) => h.title === 'Google Docs ของทีม')).toBe(true);
  });

  it('เจอจากชื่อไฟล์ (original_file_name / title)', async () => {
    const hits = await searchVault({ chatId, query: 'ใบเสนอราคา' });
    expect(hits.some((h) => h.title === 'ใบเสนอราคา.pdf')).toBe(true);
  });

  it('ไม่เจอคำที่ไม่เกี่ยวข้องเลย', async () => {
    const hits = await searchVault({ chatId, query: 'ไดโนเสาร์บินได้' });
    expect(hits).toEqual([]);
  });

  it('เรียงคะแนนมากไปน้อย', async () => {
    const hits = await searchVault({ chatId, query: 'สัญญา' });
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score);
    }
  });

  it('กรองตาม kind ได้', async () => {
    const hits = await searchVault({ chatId, query: 'ตาราง', kind: 'link' });
    expect(hits).toEqual([]);
  });

  it('ไม่เห็นของแชทอื่น', async () => {
    const other = await seedChatAndUser({ lineChatId: 'Uother-vault-000000000000001', lineUserId: 'Uother-vaultuser-0000000001' });
    await saveTextItem({ chatId: other.chatId, createdBy: 'Uother-vaultuser-0000000001', content: 'สัญญาของคนอื่น' });

    const hits = await searchVault({ chatId, query: 'สัญญา' });
    expect(hits.every((h) => h.contentText !== 'สัญญาของคนอื่น')).toBe(true);
  });

  it('คำค้นว่าง → คืน array ว่าง ไม่ query DB', async () => {
    expect(await searchVault({ chatId, query: '   ' })).toEqual([]);
  });

  it('จำกัดจำนวนผลลัพธ์ตาม limit', async () => {
    for (let i = 0; i < 5; i++) {
      await saveTextItem({ chatId, createdBy: USER, content: `สัญญาฉบับที่ ${i}` });
    }
    const hits = await searchVault({ chatId, query: 'สัญญา', limit: 2 });
    expect(hits).toHaveLength(2);
  });
});

d('vault — ค้นหาด้วย semantic (pgvector)', () => {
  it('เจอด้วยความหมายแม้ถ้อยคำต่างกันโดยสิ้นเชิง เมื่อ embedding ใกล้กันมาก', async () => {
    embeddingEnabled = true;
    // คำค้นกับเนื้อหาไม่มีคำร่วมกันเลย (ts/trgm หาไม่เจอแน่ๆ) แต่ embedding ใกล้กันมาก
    embedMock.mockResolvedValue({ ok: true, vectors: [Array(1536).fill(0.1)], costUsd: 0, tokens: 5 });

    const saved = await saveTextItem({ chatId, createdBy: USER, content: 'เอกสารข้อตกลงทางธุรกิจ' });
    if (!saved.ok) return;

    // ตั้ง embedding ตรงๆ ให้ใกล้เคียงกับ query vector มากๆ (จำลองว่าความหมายตรงกัน)
    await prisma.$executeRawUnsafe(
      `UPDATE vault_items SET embedding = $1::vector WHERE id = $2::uuid`,
      `[${Array(1536).fill(0.1).join(',')}]`,
      saved.item.id,
    );

    const hits = await searchVault({ chatId, query: 'แฟ้มสัญญาซื้อขาย' });
    expect(hits.some((h) => h.id === saved.item.id)).toBe(true);
  });

  it('embedding สร้างไม่สำเร็จ → ยัง fallback ไป tsvector/trgm ได้ ไม่ throw', async () => {
    embeddingEnabled = true;
    embedMock.mockResolvedValue({ ok: false, reason: 'api_error', detail: 'boom' });

    await saveTextItem({ chatId, createdBy: USER, content: 'ไฟล์สัญญาอีกฉบับ' });
    const hits = await searchVault({ chatId, query: 'สัญญา' });
    expect(hits.length).toBeGreaterThan(0);
  });

  it('attachEmbedding เติม embedding จริงตอนบันทึกเมื่อเปิดใช้งาน', async () => {
    embeddingEnabled = true;
    embedMock.mockResolvedValue({ ok: true, vectors: [Array(1536).fill(0.05)], costUsd: 0.00001, tokens: 3 });

    const out = await saveTextItem({ chatId, createdBy: USER, content: 'มีความหมาย' });
    if (!out.ok) return;

    const rows = await prisma.$queryRaw<Array<{ has_embedding: boolean }>>`
      SELECT embedding IS NOT NULL AS has_embedding FROM vault_items WHERE id = ${out.item.id}::uuid`;
    expect(rows[0]?.has_embedding).toBe(true);
  });
});

describe('extractUrls', () => {
  it('จับ URL ได้แม้ไม่มีช่องว่างคั่นจากคำไทยที่ตามมา', () => {
    expect(extractUrls('เอกสารอยู่ที่ https://a.co/xนะจ๊ะ')).toEqual(['https://a.co/x']);
  });

  it('ตัดวงเล็บ/จุดท้ายประโยคที่ติดมากับ URL', () => {
    expect(extractUrls('ลิงก์ (https://a.co/x) ค่ะ')).toEqual(['https://a.co/x']);
    expect(extractUrls('เปิดที่ https://a.co/x.')).toEqual(['https://a.co/x']);
  });

  it('จับได้หลายลิงก์และตัดซ้ำ', () => {
    expect(extractUrls('http://a.com และ https://b.com/y และ http://a.com อีกที').sort()).toEqual(
      ['http://a.com', 'https://b.com/y'].sort(),
    );
  });

  it('ไม่มีลิงก์ → array ว่าง', () => {
    expect(extractUrls('ไม่มีลิงก์เลยจ้า')).toEqual([]);
  });
});
