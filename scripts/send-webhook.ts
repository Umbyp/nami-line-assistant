/**
 * ยิง webhook ปลอมเข้าเซิร์ฟเวอร์ตัวเอง พร้อมเซ็น X-Line-Signature ให้ถูกต้อง
 * ใช้ทดสอบได้โดยไม่ต้องมี LINE จริงหรือ ngrok
 *
 *   npm run webhook:send -- "เตือนกินยา 18.00"
 *   npm run webhook:send -- --group "นามิ เตือนส่งรายงานทุกศุกร์"
 *   npm run webhook:send -- --follow
 *   npm run webhook:send -- --bad-signature "ทดสอบ"    (ต้องได้ 401)
 *   npm run webhook:send -- --postback '{"a":"rm.list"}'
 *   npm run webhook:send -- --postback '{"a":"settings.quiet_start"}' --params '{"time":"23:00"}'
 */
import crypto from 'node:crypto';

const secret = process.env.LINE_CHANNEL_SECRET ?? 'test-secret';
const url = process.env.WEBHOOK_URL ?? `http://localhost:${process.env.PORT ?? 3100}/webhook`;

const argv = process.argv.slice(2);
const isGroup = argv.includes('--group');
const isFollow = argv.includes('--follow');
const badSignature = argv.includes('--bad-signature');

/** อ่านค่าของ flag ที่ตามด้วยอาร์กิวเมนต์ เช่น --postback '{"a":"rm.list"}' */
function flagValue(flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

const postbackData = flagValue('--postback');
const postbackParams = flagValue('--params');

const text = argv
  .filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--postback' && argv[i - 1] !== '--params')
  .join(' ') || 'สวัสดีนามิ';

const USER_ID = process.env.TEST_USER_ID ?? 'Utest0000000000000000000000000001';
const GROUP_ID = process.env.TEST_GROUP_ID ?? 'Ctest0000000000000000000000000001';

const source = isGroup
  ? { type: 'group', groupId: GROUP_ID, userId: USER_ID }
  : { type: 'user', userId: USER_ID };

const now = Date.now();
const eventId = crypto.randomUUID();

const event = isFollow
  ? {
      type: 'follow',
      mode: 'active',
      timestamp: now,
      source,
      webhookEventId: eventId,
      deliveryContext: { isRedelivery: false },
      replyToken: crypto.randomBytes(16).toString('hex'),
    }
  : postbackData
    ? {
        type: 'postback',
        mode: 'active',
        timestamp: now,
        source,
        webhookEventId: eventId,
        deliveryContext: { isRedelivery: false },
        replyToken: crypto.randomBytes(16).toString('hex'),
        postback: {
          data: postbackData,
          ...(postbackParams ? { params: JSON.parse(postbackParams) } : {}),
        },
      }
    : {
        type: 'message',
        mode: 'active',
        timestamp: now,
        source,
        webhookEventId: eventId,
        deliveryContext: { isRedelivery: false },
        replyToken: crypto.randomBytes(16).toString('hex'),
        message: { type: 'text', id: String(now), text },
      };

const body = JSON.stringify({ destination: 'Uffffffffffffffffffffffffffffffff', events: [event] });

// header ของ HTTP ต้องเป็น ASCII เท่านั้น → ลายเซ็นปลอมต้องเป็น base64 ที่ยาวเท่าของจริงแต่ค่าผิด
const signature = badSignature
  ? crypto.createHmac('sha256', 'secret-ที่ไม่ถูกต้อง').update(body).digest('base64')
  : crypto.createHmac('sha256', secret).update(body).digest('base64');

const res = await fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-line-signature': signature },
  body,
});

console.log(`→ POST ${url}`);
console.log(`   source: ${isGroup ? 'group' : 'user'}   event: ${event.type}`);
if (event.type === 'message') console.log(`   text: ${text}`);
if (event.type === 'postback') console.log(`   postback: ${postbackData}${postbackParams ? ` params: ${postbackParams}` : ''}`);
console.log(`← ${res.status} ${res.statusText}`);
console.log(`   ${await res.text()}`);

// reply token ปลอมจะทำให้ worker reply ไม่สำเร็จ (LINE ปฏิเสธ) — ปกติ ดู log ของ worker ต่อ
if (!badSignature) {
  console.log('\nหมายเหตุ: replyToken เป็นของปลอม worker จะ log ว่า reply ไม่สำเร็จ');
  console.log('ให้ดูใน log ของ worker ว่าประมวลผล event ถึงขั้นไหน');
}
