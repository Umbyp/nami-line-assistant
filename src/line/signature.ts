import crypto from 'node:crypto';

/**
 * ตรวจ X-Line-Signature
 *   signature = Base64( HMAC-SHA256( channelSecret, rawRequestBody ) )
 *
 * สำคัญ: ต้องใช้ raw body (Buffer/string ดิบ) ไม่ใช่ JSON.stringify ของ object ที่ parse แล้ว
 * เพราะ key order / whitespace จะเปลี่ยน แล้ว hash ไม่ตรง
 */
export function computeLineSignature(channelSecret: string, rawBody: string | Buffer): string {
  return crypto.createHmac('sha256', channelSecret).update(rawBody).digest('base64');
}

export function verifyLineSignature(
  channelSecret: string,
  rawBody: string | Buffer,
  signature: string | undefined,
): boolean {
  if (!signature) return false;
  const expected = computeLineSignature(channelSecret, rawBody);
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  // ความยาวต่างกัน timingSafeEqual จะ throw → เช็คก่อน
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
