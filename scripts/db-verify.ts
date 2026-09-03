/**
 * ตรวจว่าของที่ Prisma จัดการแทนไม่ได้ยังอยู่ครบใน DB
 *
 * ทำไมต้องมี: prisma migrate diff มองไม่เห็น trigger, expression index และ HNSW index
 * มันจะสั่ง DROP หรือละเลยทุกครั้งที่ generate migration ใหม่
 * สคริปต์นี้เป็นตัวจับว่าของหายไปแล้ว ก่อนจะไปเจอตอน production ค้นหาไม่เจอ
 *
 *   npm run db:verify
 */
import { prisma } from '../src/lib/prisma.js';
import { env } from '../src/config/env.js';

interface Check {
  name: string;
  detail: string;
  sql: () => Promise<boolean>;
}

async function exists(query: Promise<Array<Record<string, unknown>>>): Promise<boolean> {
  return (await query).length > 0;
}

const checks: Check[] = [
  {
    name: 'extension: vector',
    detail: 'pgvector — ต้องมีก่อนจะใช้คอลัมน์ embedding ได้',
    sql: () => exists(prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'vector'`),
  },
  {
    name: 'extension: pg_trgm',
    detail: 'ใช้ค้น substring ภาษาไทย — ถ้าหาย การค้นคำไทยจะพัง',
    sql: () => exists(prisma.$queryRaw`SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm'`),
  },
  {
    name: 'trigger: vault_items_tsv_trigger',
    detail: 'เติม search_tsv อัตโนมัติ — ถ้าหาย full-text จะว่างทุกแถวใหม่',
    sql: () =>
      exists(prisma.$queryRaw`
        SELECT 1 FROM pg_trigger
        WHERE tgrelid = 'vault_items'::regclass
          AND tgname = 'vault_items_tsv_trigger' AND NOT tgisinternal`),
  },
  {
    name: 'index: vault_items_trgm_idx',
    detail: 'GIN + gin_trgm_ops สำหรับค้นคำไทย (prisma มองไม่เห็น expression index)',
    sql: () =>
      exists(prisma.$queryRaw`SELECT 1 FROM pg_indexes WHERE indexname = 'vault_items_trgm_idx'`),
  },
  {
    name: 'index: vault_items_embedding_idx (HNSW)',
    detail: 'prisma สั่ง DROP ตัวนี้ทุกครั้งที่ generate migration — ต้องเติมกลับเสมอ',
    sql: () =>
      exists(prisma.$queryRaw`
        SELECT 1 FROM pg_indexes
        WHERE indexname = 'vault_items_embedding_idx' AND indexdef ILIKE '%hnsw%'`),
  },
  {
    name: `embedding มี ${env.EMBEDDING_DIMENSIONS} มิติ`,
    detail: 'มิติใน DB ต้องตรงกับ EMBEDDING_DIMENSIONS ไม่งั้น insert พังตอน runtime',
    sql: async () => {
      const rows = await prisma.$queryRaw<Array<{ t: string }>>`
        SELECT format_type(a.atttypid, a.atttypmod) AS t
        FROM pg_attribute a
        WHERE a.attrelid = 'vault_items'::regclass AND a.attname = 'embedding'`;
      return rows[0]?.t === `vector(${env.EMBEDDING_DIMENSIONS})`;
    },
  },
];

let failed = 0;
for (const c of checks) {
  let ok = false;
  try {
    ok = await c.sql();
  } catch (err) {
    ok = false;
    c.detail = `${c.detail} — เช็คไม่ได้: ${(err as Error).message}`;
  }
  console.log(`${ok ? '✅' : '❌'} ${c.name}`);
  if (!ok) {
    console.log(`     ${c.detail}`);
    failed++;
  }
}

await prisma.$disconnect();

if (failed > 0) {
  console.error(`\n❌ ขาดไป ${failed} รายการ — ดู prisma/migrations/*_vault_search_infra และ *_openrouter_and_cost`);
  process.exit(1);
}
console.log('\n✅ โครงสร้างที่ prisma จัดการแทนไม่ได้ ยังอยู่ครบ');
