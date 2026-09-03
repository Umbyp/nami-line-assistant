-- ─────────────────────────────────────────────────────────────
-- P1.5: ย้าย LLM provider ไป OpenRouter + บันทึกต้นทุน USD จริง
--
-- migration นี้เขียนมือ ไม่ได้ generate ทั้งก้อน เพราะ prisma จัดการ 2 อย่างนี้ไม่ได้:
--   1. การเปลี่ยนมิติของ Unsupported("vector(N)") — prisma diff มองไม่เห็นเลย
--   2. index แบบ HNSW — prisma ไม่มีไวยากรณ์ให้ประกาศ จึงสั่ง DROP ทุกครั้งที่ generate
-- ถ้าอนาคต generate migration ใหม่แล้วเห็น DROP INDEX "vault_items_embedding_idx"
-- ต้องเติม CREATE INDEX ท้ายไฟล์กลับเข้าไปเสมอ (มี npm run db:verify คอยเช็คให้)
-- ─────────────────────────────────────────────────────────────

-- ── 1. ต้นทุน LLM เป็น USD จริงจาก OpenRouter (usage.cost) ──
-- Decimal ไม่ใช่ Float เพราะเอาไปรวมยอด/คิดเงิน
ALTER TABLE "usage_counters"
  ADD COLUMN "llm_cost_usd" DECIMAL(14,8) NOT NULL DEFAULT 0;

-- ── 2. เปลี่ยน embedding 1024 → 1536 มิติ ──
-- openai/text-embedding-3-small ผ่าน OpenRouter คืน 1536 มิติ
-- ตารางยังว่าง จึง drop + add ได้เลย ไม่ต้องแปลงข้อมูล
DROP INDEX IF EXISTS "vault_items_embedding_idx";
ALTER TABLE "vault_items" DROP COLUMN IF EXISTS "embedding";
ALTER TABLE "vault_items" ADD COLUMN "embedding" vector(1536);

-- ── 3. FK: SetNull → Restrict ──
-- created_by / line_user_id เป็น NOT NULL จึง SetNull ไม่ได้จริง (prisma เตือนถูก)
-- Restrict = ห้ามลบ user ที่ยังมีการเตือนหรือของใน vault ค้างอยู่
ALTER TABLE "group_members" DROP CONSTRAINT "group_members_line_user_id_fkey";
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_line_user_id_fkey"
  FOREIGN KEY ("line_user_id") REFERENCES "users"("line_user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reminders" DROP CONSTRAINT "reminders_created_by_fkey";
ALTER TABLE "reminders" ADD CONSTRAINT "reminders_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("line_user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "vault_items" DROP CONSTRAINT "vault_items_created_by_fkey";
ALTER TABLE "vault_items" ADD CONSTRAINT "vault_items_created_by_fkey"
  FOREIGN KEY ("created_by") REFERENCES "users"("line_user_id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 4. สร้าง HNSW index ใหม่บนคอลัมน์ 1536 มิติ ──
-- HNSW รองรับได้ถึง 2000 มิติ (1536 จึงผ่าน แต่ 3072 ของ -3-large จะไม่ผ่าน)
CREATE INDEX "vault_items_embedding_idx"
  ON "vault_items" USING hnsw ("embedding" vector_cosine_ops);
