import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';

/**
 * แปลง zod schema → JSON Schema ที่ OpenRouter strict mode ยอมรับ
 *
 * strict mode มีกฎที่ generator ทั่วไปไม่ทำให้:
 *   1. ทุก object ต้องมี additionalProperties: false
 *   2. ทุก property ต้องอยู่ใน required (ไม่มี optional)
 * ดังนั้น field ที่ "ไม่บังคับ" ต้องประกาศเป็น .nullable() ใน zod
 * แล้วให้โมเดลส่ง null มา ไม่ใช่ละไว้
 *
 * $refStrategy: 'none' เพื่อ inline ทุกอย่าง — strict mode ไม่รองรับ $ref/$defs
 *
 * และ strict mode ไม่รองรับ keyword ตรวจค่า (pattern, minLength, minimum, ...)
 * ถ้าส่งไปจะถูกปฏิเสธทั้ง request → เราถอดออกก่อน
 * ข้อจำกัดพวกนั้นยังถูกบังคับอยู่ที่ zod ตอน validate ผลลัพธ์
 * ดังนั้น schema ที่มีเงื่อนไขสำคัญควรเขียนบอกไว้ใน .describe() ให้โมเดลรู้ด้วย
 */
export function toStrictJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const raw = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' });
  return enforceStrict(raw as Record<string, unknown>) as Record<string, unknown>;
}

/**
 * keyword ที่ strict mode ปฏิเสธ — zod ยังบังคับให้เราตอน validate อยู่ดี
 * จึงถอดออกจาก JSON Schema ได้อย่างปลอดภัย
 */
const UNSUPPORTED_KEYWORDS = [
  '$schema',
  'pattern',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'format',
  'default',
] as const;

function enforceStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(enforceStrict);
  if (node === null || typeof node !== 'object') return node;

  const obj = { ...(node as Record<string, unknown>) };

  for (const k of UNSUPPORTED_KEYWORDS) delete obj[k];

  const props = obj['properties'];
  if (props && typeof props === 'object' && !Array.isArray(props)) {
    const src = props as Record<string, unknown>;
    const keys = Object.keys(src);
    obj['properties'] = Object.fromEntries(keys.map((k) => [k, enforceStrict(src[k])]));
    obj['required'] = keys;
    obj['additionalProperties'] = false;
  }

  for (const key of ['items', 'anyOf', 'allOf', 'oneOf', 'not']) {
    if (key in obj) obj[key] = enforceStrict(obj[key]);
  }

  return obj;
}
