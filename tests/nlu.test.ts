import { describe, expect, it } from 'vitest';
import { DateTime } from 'luxon';
import { needsClarification, clarificationText, sanitizeNluResult } from '../src/nlu/parse.js';
import { buildSystemPrompt, describeNow } from '../src/nlu/prompt.js';
import { NluResultSchema } from '../src/nlu/schema.js';
import { toStrictJsonSchema } from '../src/llm/jsonSchema.js';
import { BKK } from '../src/lib/time.js';
import type { NluResult } from '../src/nlu/schema.js';

function result(over: Partial<NluResult> = {}): NluResult {
  return {
    intent: 'create_reminder',
    reminder: null,
    searchQuery: null,
    ambiguousFields: [],
    clarifyQuestion: null,
    confidence: 0.95,
    ...over,
  };
}

describe('needsClarification', () => {
  it('ผลลัพธ์ชัดเจน → ไม่ต้องถาม', () => {
    expect(needsClarification(result())).toBe(false);
  });

  it('confidence ต่ำกว่า threshold → ถาม', () => {
    expect(needsClarification(result({ confidence: 0.4 }))).toBe(true);
  });

  it('มี ambiguousFields → ถาม แม้ confidence จะสูง', () => {
    // นี่คือหัวใจ: จากการวัดผลจริง confidence ไม่สม่ำเสมอ
    // ข้อความกำกวมเดียวกันได้ 0.5 กับ 0.7 ต่างรอบ
    // ถ้าพึ่ง confidence เดียวจะปล่อยของกำกวมผ่านแล้วเดาเวลาให้ผู้ใช้เอง
    expect(needsClarification(result({ confidence: 0.99, ambiguousFields: ['time'] }))).toBe(true);
  });

  it('confidence เท่ากับ threshold พอดี → ไม่ถาม', () => {
    expect(needsClarification(result({ confidence: 0.6 }))).toBe(false);
  });
});

describe('sanitizeNluResult', () => {
  const draft = {
    title: 'พักสายตา', note: null, kind: 'recurring' as const,
    dueAtLocal: null, dateWasExplicit: false, rrule: null,
    everyMinutes: 30, fireAtMinuteLocal: null, assigneeNames: [],
  };

  // เจอจริง: "ทุก 30 นาที เตือนพักสายตา" โมเดลใส่ ambiguousFields = ["time"]
  // ทั้งที่การเตือนแบบทุก N นาที ไม่มีเวลาของวันให้ระบุ → ถามกลับเป็นคำถามที่ตอบไม่ได้
  it('everyMinutes → ตัด "time" ออกจาก ambiguousFields', () => {
    const out = sanitizeNluResult(
      result({ reminder: draft, ambiguousFields: ['time'], clarifyQuestion: 'กี่โมงดี' }),
    );
    expect(out.ambiguousFields).toEqual([]);
    expect(out.clarifyQuestion).toBeNull();
    expect(needsClarification(out)).toBe(false);
  });

  it('everyMinutes แต่ยังมีอย่างอื่นกำกวม → ยังต้องถาม', () => {
    const out = sanitizeNluResult(
      result({ reminder: draft, ambiguousFields: ['time', 'title'], clarifyQuestion: 'เรื่องอะไร' }),
    );
    expect(out.ambiguousFields).toEqual(['title']);
    expect(out.clarifyQuestion).toBe('เรื่องอะไร');
    expect(needsClarification(out)).toBe(true);
  });

  it('การเตือนที่ใช้ rrule ยังต้องมีเวลา → ไม่ตัด "time"', () => {
    const out = sanitizeNluResult(
      result({
        reminder: { ...draft, everyMinutes: null, rrule: 'FREQ=MONTHLY;BYMONTHDAY=25' },
        ambiguousFields: ['time'],
      }),
    );
    expect(out.ambiguousFields).toEqual(['time']);
  });

  it('ไม่มีอะไรกำกวมเลย → คืน reference เดิม (ไม่สร้าง object ใหม่โดยไม่จำเป็น)', () => {
    const r = result({ reminder: draft, ambiguousFields: [] });
    expect(sanitizeNluResult(r)).toBe(r);
  });

  // เจอจริง: "เดี๋ยวส่งให้นะ https://... เอกสารสัญญา" (intent = save_to_vault)
  // โมเดลใส่ ambiguousFields = ["time"] ทั้งที่ save_to_vault ไม่มีแนวคิดเรื่องเวลาเลย
  // ต้องกรองทิ้งไม่ว่า intent ไหนก็ตามที่ไม่ใช่ create_reminder เพราะ ambiguousFields
  // ทุกค่า (time/date/title/recurrence/assignee) เป็นเรื่องของการตั้งเตือนเท่านั้น
  it.each(['save_to_vault', 'search_vault', 'smalltalk', 'help', 'list_reminders', 'cancel_reminder', 'unknown'] as const)(
    'intent = %s → ตัด ambiguousFields ทิ้งทั้งหมดแม้โมเดลจะใส่มา',
    (intent) => {
      const out = sanitizeNluResult(result({ intent, reminder: null, ambiguousFields: ['time'], clarifyQuestion: 'กี่โมงดี' }));
      expect(out.ambiguousFields).toEqual([]);
      expect(out.clarifyQuestion).toBeNull();
      expect(needsClarification(out)).toBe(false);
    },
  );
});

describe('clarificationText', () => {
  it('ใช้คำถามที่โมเดลเขียนมาถ้ามี', () => {
    const t = clarificationText(
      result({ ambiguousFields: ['time'], clarifyQuestion: 'เย็นๆ ประมาณกี่โมงดี' }),
    );
    expect(t).toBe('เย็นๆ ประมาณกี่โมงดี');
  });

  it('ประกอบคำถามเองถ้าโมเดลไม่ได้ให้มา', () => {
    const t = clarificationText(result({ ambiguousFields: ['time'] }));
    expect(t).toContain('กี่โมง');
  });

  it('รวมหลาย field เป็นคำถามเดียว', () => {
    const t = clarificationText(result({ ambiguousFields: ['time', 'title'] }));
    expect(t).toContain('กี่โมง');
    expect(t).toContain('เรื่องอะไร');
  });

  it('clarifyQuestion ที่เป็นช่องว่างล้วน → ใช้ fallback', () => {
    const t = clarificationText(result({ ambiguousFields: ['date'], clarifyQuestion: '   ' }));
    expect(t).toContain('วันไหน');
  });

  it('ไม่มีอะไรกำกวมแต่ confidence ต่ำ → ยังมีข้อความถามกลับ', () => {
    expect(clarificationText(result({ confidence: 0.2 }))).not.toBe('');
  });
});

describe('describeNow', () => {
  it('บอกวันในสัปดาห์ภาษาไทย + ทั้ง ค.ศ. และ พ.ศ.', () => {
    const now = DateTime.fromISO('2026-09-03T10:30', { zone: BKK }).toUTC().toJSDate();
    const s = describeNow(now, BKK);
    expect(s).toContain('พฤหัสบดี'); // 3 ก.ย. 2026 เป็นวันพฤหัสบดี
    expect(s).toContain('3 กันยายน 2026');
    expect(s).toContain('พ.ศ. 2569');
    expect(s).toContain('10:30');
  });

  it('ใช้เวลาไทย ไม่ใช่ UTC (ตี 1 ไทยต้องเป็นวันไทย)', () => {
    // 4 ก.ย. 01:00 ไทย = 3 ก.ย. 18:00 UTC
    const now = DateTime.fromISO('2026-09-04T01:00', { zone: BKK }).toUTC().toJSDate();
    const s = describeNow(now, BKK);
    expect(s).toContain('4 กันยายน');
    expect(s).toContain('ศุกร์');
  });
});

describe('buildSystemPrompt', () => {
  const now = DateTime.fromISO('2026-09-03T10:30', { zone: BKK }).toUTC().toJSDate();

  it('มีกฎเวลาไทยที่โมเดลพลาดบ่อย', () => {
    const p = buildSystemPrompt({ now, tz: BKK, isGroup: false });
    expect(p).toContain('บ่าย 3');
    expect(p).toContain('2 ทุ่ม');
    expect(p).toContain('ตี 1');
    expect(p).toContain('18.00');
  });

  it('ระบุคำกำกวมที่ห้ามเดา', () => {
    const p = buildSystemPrompt({ now, tz: BKK, isGroup: false });
    expect(p).toContain('เย็นๆ');
    expect(p).toContain('ambiguousFields');
  });

  it('บอกกฎแปลง พ.ศ. เป็น ค.ศ.', () => {
    const p = buildSystemPrompt({ now, tz: BKK, isGroup: false });
    expect(p).toContain('543');
  });

  it('ในกลุ่มเพิ่มเรื่องมอบหมายงาน และแนบชื่อสมาชิกที่รู้จัก', () => {
    const p = buildSystemPrompt({
      now,
      tz: BKK,
      isGroup: true,
      knownMemberNames: ['พี่โบ๊ท', 'นุช'],
    });
    expect(p).toContain('assigneeNames');
    expect(p).toContain('พี่โบ๊ท');
    expect(p).toContain('นุช');
  });

  it('แชท 1:1 ไม่พูดเรื่องกลุ่ม', () => {
    const p = buildSystemPrompt({ now, tz: BKK, isGroup: false });
    expect(p).not.toContain('assigneeNames');
  });
});

describe('NluResultSchema → JSON Schema ที่ส่งให้โมเดล', () => {
  const js = toStrictJsonSchema(NluResultSchema) as any;

  it('ทุก key อยู่ใน required (strict mode ไม่มี optional)', () => {
    expect(js.required.sort()).toEqual(
      ['ambiguousFields', 'clarifyQuestion', 'confidence', 'intent', 'reminder', 'searchQuery'].sort(),
    );
    expect(js.additionalProperties).toBe(false);
  });

  it('ไม่มี keyword ที่ strict mode ปฏิเสธหลงเหลือ', () => {
    const text = JSON.stringify(js);
    for (const bad of ['"pattern"', '"minLength"', '"maxLength"', '"minimum"', '"maximum"', '$ref', '$schema']) {
      expect(text).not.toContain(bad);
    }
  });

  it('description ยังอยู่ — เพราะเงื่อนไขย้ายไปอยู่ในนั้นแทน min/max', () => {
    const text = JSON.stringify(js);
    expect(text).toContain('description');
    // กฎสำคัญที่ย้ายจาก pattern ไปอยู่ใน description
    expect(text).toContain('YYYY-MM-DDTHH:mm');
  });

  it('nested reminder object ก็ strict ด้วย', () => {
    const r = js.properties.reminder;
    const obj = r.anyOf ? r.anyOf.find((x: any) => x.type === 'object') : r;
    expect(obj.additionalProperties).toBe(false);
    expect(obj.required).toContain('dateWasExplicit');
    expect(obj.required).toContain('dueAtLocal');
  });
});
