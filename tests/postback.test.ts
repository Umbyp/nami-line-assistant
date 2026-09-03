import { describe, expect, it } from 'vitest';
import {
  POSTBACK_MAX_LENGTH,
  decodePostback,
  encodePostback,
  type PostbackAction,
} from '../src/line/postback.js';

const ID = '11111111-2222-4333-8444-555555555555';
const OID = '99999999-8888-4777-8666-555555555555';

describe('encodePostback / decodePostback', () => {
  const cases: PostbackAction[] = [
    { a: 'rm.cancel', id: ID },
    { a: 'rm.retime', id: ID },
    { a: 'rm.done', oid: OID },
    { a: 'rm.snooze', oid: OID, m: 10 },
    { a: 'rm.off', id: ID },
    { a: 'rm.list' },
    { a: 'help' },
  ];

  it.each(cases.map((c) => [c.a, c] as const))('round-trip: %s', (_name, action) => {
    const encoded = encodePostback(action);
    const out = decodePostback(encoded);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.action).toEqual(action);
  });

  it('ทุก action ต้องสั้นกว่าลิมิต 300 ตัวของ LINE', () => {
    for (const c of cases) {
      expect(encodePostback(c).length).toBeLessThanOrEqual(POSTBACK_MAX_LENGTH);
    }
  });
});

describe('decodePostback — input ที่เชื่อไม่ได้', () => {
  it('ไม่มี data', () => {
    expect(decodePostback(undefined).ok).toBe(false);
    expect(decodePostback('').ok).toBe(false);
  });

  it('ไม่ใช่ JSON', () => {
    const out = decodePostback('rm.cancel:abc');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain('ไม่ใช่ JSON');
  });

  it('action ที่ไม่รู้จัก', () => {
    expect(decodePostback('{"a":"rm.dropTable","id":"x"}').ok).toBe(false);
  });

  it('id ไม่ใช่ uuid → ปฏิเสธ (กันยัดค่าอื่นเข้ามา)', () => {
    expect(decodePostback('{"a":"rm.cancel","id":"1 OR 1=1"}').ok).toBe(false);
    expect(decodePostback('{"a":"rm.cancel","id":""}').ok).toBe(false);
  });

  it('ขาด field ที่บังคับ', () => {
    expect(decodePostback('{"a":"rm.cancel"}').ok).toBe(false);
    expect(decodePostback(`{"a":"rm.snooze","oid":"${OID}"}`).ok).toBe(false);
  });

  it('snooze ที่นาทีติดลบหรือศูนย์ → ปฏิเสธ', () => {
    expect(decodePostback(`{"a":"rm.snooze","oid":"${OID}","m":0}`).ok).toBe(false);
    expect(decodePostback(`{"a":"rm.snooze","oid":"${OID}","m":-10}`).ok).toBe(false);
  });

  it('data ยาวเกินลิมิต → ปฏิเสธก่อน parse', () => {
    const out = decodePostback('x'.repeat(POSTBACK_MAX_LENGTH + 1));
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.detail).toContain('ยาวเกินลิมิต');
  });

  it('encode ที่ยาวเกินลิมิต → throw เพราะเป็นความผิดของเราไม่ใช่ผู้ใช้', () => {
    expect(() =>
      encodePostback({ a: 'rm.cancel', id: 'x'.repeat(400) } as unknown as PostbackAction),
    ).toThrow(/เกินลิมิต/);
  });
});
