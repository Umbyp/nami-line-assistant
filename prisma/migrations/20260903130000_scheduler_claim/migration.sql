-- ─────────────────────────────────────────────────────────────
-- P3: scheduler ที่ทน restart และไม่ยิงซ้ำ
-- ─────────────────────────────────────────────────────────────

-- ── 1. สถานะ sending สำหรับ "จองแถวก่อนยิง" ──
-- ลำดับที่ปลอดภัย: pending → (claim) sending → push → sent
-- ถ้ายิงไม่สำเร็จ: sending → pending (ถ้ายัง retry ได้) หรือ failed
-- ถ้า process ตายตอน sending: sweeper พาย้อนกลับเป็น pending
--
-- ทำไมไม่ push ก่อนแล้วค่อย mark sent: ถ้าตายระหว่างนั้นจะยิงซ้ำ ซึ่งเสียเงินและกวนผู้ใช้
-- ทำไมไม่ mark sent ก่อนแล้ว push: ถ้าตายระหว่างนั้น การเตือนจะหายเงียบๆ กู้ไม่ได้
ALTER TYPE "OccurrenceStatus" ADD VALUE IF NOT EXISTS 'sending' AFTER 'pending';

-- ── 2. เวลาที่ claim ใช้หาแถวค้าง ──
ALTER TABLE "reminder_occurrences"
  ADD COLUMN "claimed_at" TIMESTAMPTZ(3);

-- ── 3. เวลาตามตารางจริงก่อนถูกเลื่อนเพราะ quiet hours ──
-- ถ้าไม่เก็บ: เตือนทุกวัน 23:00 ที่ถูกเลื่อนไป 07:00 จะทำให้รอบถัดไป
-- คำนวณจาก 07:00 แล้วตารางค่อยๆ เพี้ยนออกจากที่ผู้ใช้ตั้งไว้
ALTER TABLE "reminder_occurrences"
  ADD COLUMN "canonical_fire_at_utc" TIMESTAMPTZ(3);

-- แถวที่มีอยู่แล้วยังไม่ถูกเลื่อน จึง canonical = fire_at
UPDATE "reminder_occurrences" SET "canonical_fire_at_utc" = "fire_at_utc"
  WHERE "canonical_fire_at_utc" IS NULL;

-- ── 4. index สำหรับ sweeper หาแถวค้าง ──
CREATE INDEX "reminder_occurrences_status_claimed_at_idx"
  ON "reminder_occurrences"("status", "claimed_at");
