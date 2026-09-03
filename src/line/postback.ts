import { z } from 'zod';

/**
 * postback data ของ LINE จำกัด 300 ตัวอักษร
 * เราเก็บเป็น JSON คีย์สั้นๆ แล้ว validate ด้วย zod ตอนถอด
 *
 * ทำไมต้อง validate: postback data เดินทางผ่านเครื่องผู้ใช้
 * ถึงจะแก้ยากแต่ก็ไม่ควรเชื่อ — ห้ามเอา id จาก postback ไปใช้ตรงๆ
 * โดยไม่เช็คว่าเป็นของแชทนั้นจริง (handler เช็คให้)
 */
export const POSTBACK_MAX_LENGTH = 300;

export const PostbackSchema = z.discriminatedUnion('a', [
  /** ยกเลิกการเตือน */
  z.object({ a: z.literal('rm.cancel'), id: z.string().uuid() }),
  /** เปลี่ยนเวลา — ค่าเวลาที่เลือกมาอยู่ใน postback.params.datetime */
  z.object({ a: z.literal('rm.retime'), id: z.string().uuid() }),
  /** กดว่าเสร็จแล้ว (ใช้ตอนนามิยิงเตือน — P3) */
  z.object({ a: z.literal('rm.done'), oid: z.string().uuid() }),
  /** เลื่อนไป N นาที (P3) */
  z.object({ a: z.literal('rm.snooze'), oid: z.string().uuid(), m: z.number().int().positive() }),
  /** ปิดการเตือนนี้ถาวรจากปุ่มบน push (P3) */
  z.object({ a: z.literal('rm.off'), id: z.string().uuid() }),
  /** ดูรายการเตือนทั้งหมด */
  z.object({ a: z.literal('rm.list') }),
  /** ขอไฟล์/รูปจาก vault กลับมาในแชท */
  z.object({ a: z.literal('vault.send'), id: z.string().uuid() }),
  /** ดูของที่เก็บไว้ล่าสุด (ปุ่มเมนู "โน้ต-ไฟล์") */
  z.object({ a: z.literal('vault.list') }),
  /** เปิดหน้าตั้งค่า (ปุ่มเมนู "ตั้งค่า") */
  z.object({ a: z.literal('settings.view') }),
  /** ปรับเวลาเริ่มช่วงเงียบ — ค่าที่เลือกอยู่ใน postback.params.time */
  z.object({ a: z.literal('settings.quiet_start') }),
  /** ปรับเวลาสิ้นสุดช่วงเงียบ — ค่าที่เลือกอยู่ใน postback.params.time */
  z.object({ a: z.literal('settings.quiet_end') }),
  /** ปิดช่วงเวลาเงียบทั้งหมด */
  z.object({ a: z.literal('settings.quiet_off') }),
  /** เปิดช่วงเวลาเงียบกลับมาด้วยค่าดีฟอลต์ */
  z.object({ a: z.literal('settings.quiet_on') }),
  /** ช่วยเหลือ */
  z.object({ a: z.literal('help') }),
]);

export type PostbackAction = z.infer<typeof PostbackSchema>;

export function encodePostback(action: PostbackAction): string {
  const s = JSON.stringify(action);
  if (s.length > POSTBACK_MAX_LENGTH) {
    // ถ้าเกิดขึ้นคือเราออกแบบ action ผิด ไม่ใช่ความผิดของผู้ใช้ — ให้ดังตอน dev
    throw new Error(`postback data ยาว ${s.length} ตัว เกินลิมิต ${POSTBACK_MAX_LENGTH}: ${s}`);
  }
  return s;
}

export type DecodeResult =
  | { ok: true; action: PostbackAction }
  | { ok: false; detail: string };

export function decodePostback(data: string | undefined): DecodeResult {
  if (!data) return { ok: false, detail: 'ไม่มี postback data' };
  if (data.length > POSTBACK_MAX_LENGTH) {
    return { ok: false, detail: `postback data ยาวเกินลิมิต (${data.length})` };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(data);
  } catch {
    return { ok: false, detail: `postback data ไม่ใช่ JSON: ${data.slice(0, 80)}` };
  }

  const parsed = PostbackSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    };
  }
  return { ok: true, action: parsed.data };
}
