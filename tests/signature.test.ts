import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { computeLineSignature, verifyLineSignature } from '../src/line/signature.js';

const SECRET = 'my-channel-secret';

describe('LINE signature', () => {
  it('ตรงกับสูตรของ LINE: base64(hmac-sha256(secret, rawBody))', () => {
    const body = '{"destination":"U1","events":[]}';
    const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64');
    expect(computeLineSignature(SECRET, body)).toBe(expected);
  });

  it('ผ่านเมื่อ signature ถูกต้อง', () => {
    const body = Buffer.from('{"events":[{"type":"message"}]}');
    const sig = computeLineSignature(SECRET, body);
    expect(verifyLineSignature(SECRET, body, sig)).toBe(true);
  });

  it('ไม่ผ่านเมื่อ body ถูกแก้แม้แต่ตัวเดียว', () => {
    const body = '{"events":[{"type":"message"}]}';
    const sig = computeLineSignature(SECRET, body);
    expect(verifyLineSignature(SECRET, `${body} `, sig)).toBe(false);
  });

  it('ไม่ผ่านเมื่อ secret ผิด', () => {
    const body = '{"events":[]}';
    const sig = computeLineSignature('secret-อื่น', body);
    expect(verifyLineSignature(SECRET, body, sig)).toBe(false);
  });

  it('ไม่ผ่านเมื่อไม่มี header signature', () => {
    expect(verifyLineSignature(SECRET, '{}', undefined)).toBe(false);
    expect(verifyLineSignature(SECRET, '{}', '')).toBe(false);
  });

  it('ไม่ throw เมื่อ signature ยาวไม่เท่ากัน (timingSafeEqual จะ throw ถ้าไม่เช็คก่อน)', () => {
    expect(() => verifyLineSignature(SECRET, '{}', 'สั้นเกิน')).not.toThrow();
    expect(verifyLineSignature(SECRET, '{}', 'สั้นเกิน')).toBe(false);
  });

  it('ต้องคำนวณจาก byte ดิบ ไม่ใช่ JSON ที่ parse แล้ว stringify ใหม่', () => {
    // LINE ส่ง key มาเรียงแบบนี้ ถ้าเรา parse แล้ว stringify ใหม่ ลำดับ/ช่องว่างจะเปลี่ยน
    const raw = '{ "destination":"U1",\n  "events": [] }';
    const sig = computeLineSignature(SECRET, raw);
    const reStringified = JSON.stringify(JSON.parse(raw));
    expect(verifyLineSignature(SECRET, reStringified, sig)).toBe(false);
    expect(verifyLineSignature(SECRET, raw, sig)).toBe(true);
  });
});
