import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

/**
 * เทสต์ชั้น LLM โดยไม่ยิง API จริง
 * สิ่งที่ต้องพิสูจน์: ฟังก์ชันนี้ "ไม่ throw" และ "ไม่เดา"
 * ถ้าโมเดลตอบมั่ว ต้องคืน ok:false ให้ผู้เรียกไปถามผู้ใช้กลับ
 */
const create = vi.fn();
const recordLlmUsage = vi.fn(async () => undefined);

vi.mock('../src/llm/client.js', async () => {
  const actual = await vi.importActual<typeof import('../src/llm/client.js')>(
    '../src/llm/client.js',
  );
  return {
    ...actual,
    llm: { chat: { completions: { create } }, embeddings: { create: vi.fn() } },
    isLlmConfigured: () => true,
  };
});

vi.mock('../src/line/usage.js', () => ({ recordLlmUsage }));

const { completeStructured, stripCodeFence } = await import('../src/llm/chat.js');
const { toStrictJsonSchema } = await import('../src/llm/jsonSchema.js');

const Schema = z.object({
  title: z.string(),
  minute: z.number().int().nullable(),
});

function res(content: string | null, cost = 0.000012, tokens = 40) {
  return {
    choices: [{ message: { content } }],
    usage: { total_tokens: tokens, cost },
  };
}

const req = { name: 'test', schema: Schema, system: 'sys', user: 'ผู้ใช้พิมพ์อะไรมา' };

beforeEach(() => {
  create.mockReset();
  recordLlmUsage.mockClear();
});

describe('completeStructured — เส้นทางปกติ', () => {
  it('คืน data ที่ผ่าน zod แล้ว พร้อมต้นทุนจริง', async () => {
    create.mockResolvedValueOnce(res('{"title":"กินยา","minute":1080}'));
    const out = await completeStructured(req);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.data).toEqual({ title: 'กินยา', minute: 1080 });
    expect(out.costUsd).toBeCloseTo(0.000012, 9);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('ส่ง json_schema strict ไปให้ provider', async () => {
    create.mockResolvedValueOnce(res('{"title":"x","minute":null}'));
    await completeStructured(req);
    const arg = create.mock.calls[0]?.[0] as Record<string, any>;
    expect(arg.response_format.type).toBe('json_schema');
    expect(arg.response_format.json_schema.strict).toBe(true);
    expect(arg.temperature).toBe(0);
  });

  it('ปอก ```json ที่บางโมเดลห่อมาให้ แม้สั่ง strict ไปแล้ว', async () => {
    create.mockResolvedValueOnce(res('```json\n{"title":"ประชุม","minute":900}\n```'));
    const out = await completeStructured(req);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.title).toBe('ประชุม');
  });

  it('เลือกโมเดลตาม tier — vision ใช้อีกตัว', async () => {
    create.mockResolvedValue(res('{"title":"x","minute":null}'));
    await completeStructured({ ...req, tier: 'text' });
    await completeStructured({ ...req, tier: 'vision' });
    const m1 = (create.mock.calls[0]?.[0] as any).model;
    const m2 = (create.mock.calls[1]?.[0] as any).model;
    expect(m1).not.toBe(m2);
  });

  it('แปลงรูปเป็น data URI ใน content part', async () => {
    create.mockResolvedValueOnce(res('{"title":"x","minute":null}'));
    await completeStructured({
      ...req,
      tier: 'vision',
      user: [
        { type: 'text', text: 'อ่านรูปนี้' },
        { type: 'image', mime: 'image/png', base64: 'AAAA' },
      ],
    });
    const parts = (create.mock.calls[0]?.[0] as any).messages[1].content;
    expect(parts[1].image_url.url).toBe('data:image/png;base64,AAAA');
  });
});

describe('completeStructured — เส้นทางพัง (ต้องไม่เดา)', () => {
  it('JSON เสีย → ลองซ่อม 1 ครั้ง แล้วสำเร็จ', async () => {
    create
      .mockResolvedValueOnce(res('นี่ไม่ใช่ JSON เลย'))
      .mockResolvedValueOnce(res('{"title":"ซ่อมแล้ว","minute":600}'));
    const out = await completeStructured(req);
    expect(create).toHaveBeenCalledTimes(2);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.data.title).toBe('ซ่อมแล้ว');
  });

  it('รอบซ่อมส่งข้อผิดพลาดกลับไปให้โมเดลด้วย', async () => {
    create
      .mockResolvedValueOnce(res('พัง'))
      .mockResolvedValueOnce(res('{"title":"ok","minute":null}'));
    await completeStructured(req);
    const msgs = (create.mock.calls[1]?.[0] as any).messages;
    expect(msgs).toHaveLength(4); // system, user, assistant, repair
    expect(msgs[3].content).toContain('invalid_json');
  });

  it('JSON เสียทั้ง 2 รอบ → ok:false ไม่ throw', async () => {
    create.mockResolvedValue(res('ยังพังอยู่'));
    const out = await completeStructured(req);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('invalid_json');
  });

  it('JSON ถูกแต่ schema ไม่ตรง → schema_mismatch ไม่ใช่ปล่อยผ่าน', async () => {
    // minute เป็น string ทั้งที่ schema บอกว่า number
    create.mockResolvedValue(res('{"title":"x","minute":"หกโมง"}'));
    const out = await completeStructured(req);
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('schema_mismatch');
    expect(out.detail).toContain('minute');
  });

  it('ขาด field ที่บังคับ → ไม่เติมค่าเดาให้', async () => {
    create.mockResolvedValue(res('{"minute":600}'));
    const out = await completeStructured(req);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('schema_mismatch');
  });

  it('โมเดลตอบว่าง → empty_response', async () => {
    create.mockResolvedValue(res(''));
    const out = await completeStructured(req);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe('empty_response');
  });

  it('API พัง → api_error และไม่ retry ซ่อม (ปล่อยให้ BullMQ retry)', async () => {
    create.mockRejectedValue(new Error('429 rate limited'));
    const out = await completeStructured(req);
    expect(create).toHaveBeenCalledTimes(1);
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.reason).toBe('api_error');
      expect(out.detail).toContain('429');
    }
  });

  it('บันทึกต้นทุนแม้ผลลัพธ์ใช้ไม่ได้ — เพราะเราจ่ายเงินไปแล้วจริง', async () => {
    create.mockResolvedValue(res('พัง', 0.00004));
    const out = await completeStructured({ ...req, scopeId: 'U123' });
    expect(out.ok).toBe(false);
    expect(recordLlmUsage).toHaveBeenCalledWith('U123', 80, expect.closeTo(0.00008, 9));
  });

  it('ไม่บันทึกต้นทุนถ้าไม่ได้ส่ง scopeId มา', async () => {
    create.mockResolvedValue(res('{"title":"x","minute":null}'));
    await completeStructured(req);
    expect(recordLlmUsage).not.toHaveBeenCalled();
  });
});

describe('stripCodeFence', () => {
  it('ปอก fence ที่มี/ไม่มี ภาษา', () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('```\n{"a":1}\n```')).toBe('{"a":1}');
  });
  it('ไม่แตะข้อความที่ไม่มี fence', () => {
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
  });
});

describe('toStrictJsonSchema', () => {
  it('บังคับ additionalProperties:false และ required ทุก key', () => {
    const js = toStrictJsonSchema(Schema) as any;
    expect(js.additionalProperties).toBe(false);
    expect(js.required.sort()).toEqual(['minute', 'title']);
  });

  it('field ที่เป็น .nullable() ยังต้องอยู่ใน required (strict mode ไม่มี optional)', () => {
    const js = toStrictJsonSchema(z.object({ a: z.string().nullable() })) as any;
    expect(js.required).toEqual(['a']);
  });

  it('ไล่เข้า nested object และ array ด้วย', () => {
    const nested = z.object({
      items: z.array(z.object({ name: z.string(), n: z.number() })),
    });
    const js = toStrictJsonSchema(nested) as any;
    expect(js.properties.items.items.additionalProperties).toBe(false);
    expect(js.properties.items.items.required.sort()).toEqual(['n', 'name']);
  });

  it('ไม่มี $schema และ $ref หลงเหลือ (strict mode ไม่รองรับ)', () => {
    const shared = z.object({ x: z.number() });
    const js = toStrictJsonSchema(z.object({ a: shared, b: shared }));
    const text = JSON.stringify(js);
    expect(text).not.toContain('$ref');
    expect(text).not.toContain('$schema');
  });
});
