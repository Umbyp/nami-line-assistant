import { z } from 'zod';

/**
 * ─────────────────────────────────────────────────────────────
 * schema ของผลลัพธ์ NLU — เป็นแหล่งความจริงเดียว
 * JSON Schema ที่ส่งให้โมเดลถูก derive จากตัวนี้ (toStrictJsonSchema)
 *
 * กฎ: ทุก field ต้องเป็น .nullable() ไม่ใช่ .optional()
 *     เพราะ strict mode บังคับว่าทุก key ต้องอยู่ใน required
 *     ให้โมเดลส่ง null มา ไม่ใช่ละไว้
 *
 * กฎ 2: เงื่อนไขที่สำคัญต้องเขียนใน .describe() ด้วย
 *       เพราะ strict mode ไม่รับ pattern/min/max — zod บังคับอยู่ฝั่งเราเท่านั้น
 * ─────────────────────────────────────────────────────────────
 */

export const NluIntentSchema = z.enum([
  'create_reminder',
  'list_reminders',
  'cancel_reminder',
  'search_vault',
  'save_to_vault',
  'help',
  'smalltalk',
  'unknown',
]);
export type NluIntent = z.infer<typeof NluIntentSchema>;

/** field ที่กำกวมได้ — ใช้ตัดสินว่าจะถามกลับเรื่องอะไร */
export const AmbiguousFieldSchema = z.enum([
  'time',
  'date',
  'title',
  'recurrence',
  'assignee',
]);
export type AmbiguousField = z.infer<typeof AmbiguousFieldSchema>;

/** เข้ม: ใช้กับค่าที่ datetimepicker ของ LINE ส่งมา (ละเอียดถึงนาทีเท่านั้น) */
export const LOCAL_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * ยืดหยุ่น: ใช้กับค่าที่ LLM ส่งมา
 * โมเดลมักเติมวินาทีมาให้เอง (2026-09-03T18:00:00) แม้จะสั่งว่าเอาแค่นาที
 * ยอมรับแล้วตัดวินาทีทิ้งเองดีกว่าปฏิเสธทั้งคำขอ — แต่ยังไม่รับ offset/Z
 * เพราะถ้าโมเดลส่ง Z มาจะกลายเป็นคนละเวลากันเลย
 */
export const LOCAL_DATETIME_LOOSE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/;

export const ReminderDraftSchema = z.object({
  title: z
    .string()
    .min(1)
    .max(200)
    .describe(
      'ชื่อเรื่องที่จะเตือน ห้ามมีวลีบอกเวลาปนอยู่ ' +
        'เช่น "พรุ่งนี้บ่าย 3 ประชุมกับลูกค้า" → title = "ประชุมกับลูกค้า" ไม่ใช่ "บ่าย 3 ประชุม" ' +
        'ถ้าหาชื่อเรื่องจริงไม่ได้เลย ให้ใส่ ambiguousFields = ["title"]',
    ),
  note: z.string().max(500).nullable().describe('รายละเอียดเพิ่มเติมถ้ามี ไม่มีให้ใส่ null'),
  kind: z
    .enum(['once', 'recurring'])
    .nullable()
    .describe('once = เตือนครั้งเดียว, recurring = เตือนซ้ำ ถ้าไม่แน่ใจให้ null'),
  dueAtLocal: z
    .string()
    .regex(LOCAL_DATETIME_LOOSE_RE, 'ต้องเป็น YYYY-MM-DDTHH:mm (ห้ามมี timezone offset)')
    .nullable()
    .describe(
      'ใช้เมื่อ kind = once เท่านั้น รูปแบบ YYYY-MM-DDTHH:mm เป็นเวลาไทย (ไม่ต้องใส่ offset) ' +
        'ปีต้องเป็น ค.ศ. เสมอ เช่น 2026-09-04T15:00 ' +
        'ถ้า kind = recurring ให้ใส่ null',
    ),
  dateWasExplicit: z
    .boolean()
    .describe(
      'ผู้ใช้ระบุ "วัน" มาชัดเจนไหม (พรุ่งนี้/วันศุกร์/25 ก.ย. = true) ' +
        'ถ้าบอกแต่เวลาโดยไม่บอกวัน เช่น "เตือน 18.00" = false',
    ),
  rrule: z
    .string()
    .max(200)
    .nullable()
    .describe(
      'ใช้เมื่อ kind = recurring รูปแบบ RFC 5545 โดยไม่ต้องมี DTSTART ' +
        'เช่น FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR หรือ FREQ=MONTHLY;BYMONTHDAY=25 ' +
        'ถ้า kind = once ให้ใส่ null',
    ),
  everyMinutes: z
    .number()
    .int()
    .positive()
    .max(525_600)
    .nullable()
    .describe('ใช้เมื่อผู้ใช้บอกว่า "ทุก N นาที/ชั่วโมง" เท่านั้น นอกนั้นใส่ null'),
  fireAtMinuteLocal: z
    .number()
    .int()
    .min(0)
    .max(1439)
    .nullable()
    .describe(
      'ใช้กับ recurring: เวลาที่จะเตือนเป็นนาทีนับจากเที่ยงคืน เวลาไทย ' +
        '(8 โมงเช้า = 480, 17:30 = 1050) ถ้า kind = once ให้ใส่ null',
    ),
  assigneeNames: z
    .array(z.string().max(60))
    .max(10)
    .describe(
      'ชื่อคนที่ถูกมอบหมายในกลุ่ม ตามที่ผู้ใช้พิมพ์มา เช่น ["พี่โบ๊ท"] ' +
        'ไม่มีให้ใส่ array ว่าง',
    ),
});
export type ReminderDraft = z.infer<typeof ReminderDraftSchema>;

export const NluResultSchema = z.object({
  intent: NluIntentSchema.describe('เจตนาของผู้ใช้'),
  reminder: ReminderDraftSchema.nullable().describe(
    'ใส่เฉพาะเมื่อ intent = create_reminder นอกนั้นใส่ null',
  ),
  searchQuery: z
    .string()
    .max(300)
    .nullable()
    .describe('ใส่เฉพาะเมื่อ intent = search_vault คือสิ่งที่ผู้ใช้อยากค้น'),
  ambiguousFields: z
    .array(AmbiguousFieldSchema)
    .max(5)
    .describe(
      'สิ่งที่ผู้ใช้ไม่ได้ระบุชัดจนเดาไม่ได้ ต้องถามกลับ ' +
        'ตัวอย่างที่ต้องใส่ "time": "เย็นๆ" "ตอนบ่าย" "ดึกๆ" "เร็วๆ นี้" ' +
        'ถ้าผู้ใช้บอกเวลาชัด (18.00, บ่าย 3, 2 ทุ่ม) ห้ามใส่ ' +
        'ไม่มีอะไรกำกวมให้ใส่ array ว่าง',
    ),
  clarifyQuestion: z
    .string()
    .max(300)
    .nullable()
    .describe(
      'คำถามภาษาไทยสั้นๆ ที่จะถามผู้ใช้กลับ พูดแบบผู้หญิงสุภาพ ลงท้ายด้วย "คะ"/"ค่ะ" เสมอ ' +
        'เช่น "เย็นๆ ประมาณกี่โมงดีคะ" ใส่เมื่อ ambiguousFields ไม่ว่าง ไม่มีอะไรต้องถามให้ใส่ null',
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe('ความมั่นใจในผลลัพธ์ทั้งก้อน 0 ถึง 1'),
});
export type NluResult = z.infer<typeof NluResultSchema>;
