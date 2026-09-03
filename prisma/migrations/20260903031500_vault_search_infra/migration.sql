-- ─────────────────────────────────────────────────────────────
-- โครงสร้างการค้นหาของ vault ที่ Prisma เขียนแทนไม่ได้
--
-- ทำไมใช้ trigger ไม่ใช่ generated column:
--   generated column ต้องใช้นิพจน์ที่ IMMUTABLE เท่านั้น
--   แต่ array_to_string() เป็น STABLE จึงใส่ tags ไม่ได้
--   และ Prisma diff จะมองเห็น generated column เป็น drift ทุกครั้ง
--   trigger อยู่นอกสายตา Prisma → ไม่มี drift
--
-- ข้อจำกัดที่ต้องรู้:
--   PostgreSQL ไม่มี text search config สำหรับภาษาไทย และภาษาไทยไม่เว้นวรรคระหว่างคำ
--   ดังนั้น to_tsvector('simple', ...) จะจับได้ดีแค่คำอังกฤษ/ชื่อไฟล์/ตัวเลข
--   การค้นคำไทยจึงพึ่ง GIN + pg_trgm (จับ substring) และ pgvector (semantic) เป็นหลัก
-- ─────────────────────────────────────────────────────────────

-- ── 1. เติม search_tsv อัตโนมัติทุกครั้งที่ insert/update ──
CREATE OR REPLACE FUNCTION vault_items_tsv_update() RETURNS trigger AS $$
BEGIN
  NEW."search_tsv" :=
    setweight(to_tsvector('simple', coalesce(NEW."title", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(NEW."original_file_name", '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(array_to_string(NEW."tags", ' '), '')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW."content_text", '')), 'C');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS vault_items_tsv_trigger ON "vault_items";
CREATE TRIGGER vault_items_tsv_trigger
  BEFORE INSERT OR UPDATE OF "title", "content_text", "original_file_name", "tags"
  ON "vault_items"
  FOR EACH ROW EXECUTE FUNCTION vault_items_tsv_update();

-- ── 2. index สำหรับ full-text ──
CREATE INDEX IF NOT EXISTS "vault_items_search_tsv_idx"
  ON "vault_items" USING GIN ("search_tsv");

-- ── 3. index สำหรับค้น substring ภาษาไทย (pg_trgm) ──
-- ต้องใส่ expression เดียวกันตอน query เป๊ะๆ ไม่งั้น planner ไม่ใช้ index
CREATE INDEX IF NOT EXISTS "vault_items_trgm_idx"
  ON "vault_items" USING GIN (
    (
      lower(
        coalesce("title", '') || ' ' ||
        coalesce("original_file_name", '') || ' ' ||
        coalesce("content_text", '')
      )
    ) gin_trgm_ops
  );

-- ── 4. index สำหรับค้นด้วย tag ──
CREATE INDEX IF NOT EXISTS "vault_items_tags_idx"
  ON "vault_items" USING GIN ("tags");

-- ── 5. index สำหรับ semantic search (pgvector, cosine distance) ──
-- HNSW แม่นกว่าและไม่ต้อง train เหมือน ivfflat (เหมาะกับตารางที่ค่อยๆ โตจาก 0 แถว)
CREATE INDEX IF NOT EXISTS "vault_items_embedding_idx"
  ON "vault_items" USING hnsw ("embedding" vector_cosine_ops);

-- ── 6. เติม search_tsv ให้แถวที่มีอยู่แล้ว (ตอนนี้ยังว่าง แต่กัน migration ซ้ำในอนาคต) ──
UPDATE "vault_items" SET "title" = "title" WHERE "search_tsv" IS NULL;
