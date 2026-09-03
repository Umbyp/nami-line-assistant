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
 */
export function toStrictJsonSchema(schema: ZodTypeAny): Record<string, unknown> {
  const raw = zodToJsonSchema(schema, { $refStrategy: 'none', target: 'jsonSchema7' });
  return enforceStrict(raw as Record<string, unknown>) as Record<string, unknown>;
}

function enforceStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(enforceStrict);
  if (node === null || typeof node !== 'object') return node;

  const obj = { ...(node as Record<string, unknown>) };

  // zod-to-json-schema ใส่ $schema ไว้ที่ root — strict mode ไม่ต้องการ
  delete obj['$schema'];

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
