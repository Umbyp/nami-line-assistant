import { z } from 'zod';

/**
 * ผลจากอ่านรูปด้วย vision — ทุก field เป็น .nullable() ไม่ใช่ .optional()
 * ด้วยเหตุผลเดียวกับ NluResultSchema (strict mode ของ OpenRouter บังคับทุก key อยู่ใน required)
 */

export const ImageDocTypeSchema = z.enum([
  'appointment',
  'class_schedule',
  'shift_roster',
  'receipt',
  'other',
]);
export type ImageDocType = z.infer<typeof ImageDocTypeSchema>;

export const ImageReminderItemSchema = z.object({
  title: z
    .string()
    .describe('ชื่อเรื่องที่จะเตือน สั้น กระชับ ไม่ต้องพ่วงวันเวลา เช่น "นัดตรวจติดตามอาการ"'),
  kind: z.enum(['once', 'recurring']).describe('once = เกิดครั้งเดียวมีวันที่ชัดในเอกสาร, recurring = ซ้ำทุกสัปดาห์ (เช่นตารางเรียน/ตารางเวรที่วนทุกสัปดาห์)'),
  dateLocal: z
    .string()
    .nullable()
    .describe(
      'ใช้เมื่อ kind=once เท่านั้น รูปแบบ YYYY-MM-DD เป็นปี ค.ศ. เสมอ ' +
        '(เอกสารไทยมักเขียนปี พ.ศ. ต้องแปลงเป็น ค.ศ. โดยลบ 543) ถ้า kind=recurring ให้ null',
    ),
  weekday: z
    .enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])
    .nullable()
    .describe('ใช้เมื่อ kind=recurring คือวันในสัปดาห์ที่ซ้ำ ถ้า kind=once ให้ null'),
  timeText: z
    .string()
    .describe(
      'เวลาที่อ่านได้จากเอกสาร คัดลอกมาให้ใกล้เคียงต้นฉบับที่สุด เช่น "09:30" "8 โมงเช้า" "13.00 น." ' +
        'ห้ามคำนวณเป็นตัวเลขเอง ให้ยกคำที่เห็นมาตรงๆ',
    ),
  confidence: z.number().describe('ความมั่นใจว่าอ่านรายการนี้ถูกต้อง 0 ถึง 1'),
});
export type ImageReminderItem = z.infer<typeof ImageReminderItemSchema>;

export const ImageExtractionSchema = z.object({
  docType: ImageDocTypeSchema.describe('ชนิดเอกสารที่เห็นในรูป'),
  reminders: z
    .array(ImageReminderItemSchema)
    .max(20)
    .describe('รายการเตือนทั้งหมดที่ควรตั้งจากเอกสารนี้ ไม่มีเลยให้ใส่ array ว่าง'),
  unclearNotes: z
    .array(z.string())
    .max(10)
    .describe(
      'สิ่งที่อ่านไม่ชัดหรือไม่มั่นใจ ต้องบอกผู้ใช้ให้ตรวจสอบเอง เช่น "ตัวเลขวันที่เลือนไม่แน่ใจว่า 12 หรือ 17" ' +
        'ไม่มีให้ใส่ array ว่าง ห้ามเดาแล้วไม่บอก',
    ),
});
export type ImageExtraction = z.infer<typeof ImageExtractionSchema>;

/** item ที่ผ่านการตรวจทานเวลาแบบ deterministic แล้ว พร้อมสร้างเป็น reminder จริง */
export interface ResolvedDraftItem {
  title: string;
  kind: 'once' | 'recurring';
  dueAtUtc: Date | null;
  rrule: string | null;
  fireAtMinuteLocal: number | null;
  confidence: number;
  /** เหตุผลที่ item นี้สร้างเตือนไม่ได้ (ไม่นับรวมตอนยืนยัน) */
  problem: string | null;
}

export const LOCAL_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
