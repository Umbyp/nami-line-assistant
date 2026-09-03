import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * ทดสอบ route /webhook ด้วย fastify.inject (ไม่เปิด port จริง)
 * mock ทุกอย่างที่ต่อออกนอก process เพื่อให้เทสต์รันได้โดยไม่ต้องมี Redis/Postgres
 */
const addBulk = vi.fn(async () => []);

vi.mock('../src/queue/queues.js', () => ({
  QUEUE: { events: 'events', fire: 'reminder-fire', scheduler: 'scheduler' },
  QUEUE_PREFIX: 'nami',
  eventsQueue: { addBulk },
  fireQueue: {},
  schedulerQueue: {},
  closeQueues: vi.fn(),
}));

vi.mock('../src/lib/redis.js', () => ({
  redis: { ping: vi.fn(async () => 'PONG') },
  createRedis: vi.fn(),
}));

vi.mock('../src/lib/prisma.js', () => ({
  prisma: { $queryRaw: vi.fn(async () => [{ '?column?': 1 }]) },
}));

vi.mock('../src/line/client.js', () => ({
  lineClient: {},
  lineBlobClient: {},
}));

const { buildServer } = await import('../src/webhook/server.js');
const { computeLineSignature } = await import('../src/line/signature.js');

const SECRET = 'test-secret'; // ตรงกับ LINE_CHANNEL_SECRET ใน vitest.config.ts
const app = await buildServer();

function makeBody(events: unknown[]): string {
  return JSON.stringify({ destination: 'Ufffffffffffffffffffffffffffffff0', events });
}

function textEvent(id: string, text = 'สวัสดี'): Record<string, unknown> {
  return {
    type: 'message',
    mode: 'active',
    timestamp: 1_788_000_000_000,
    source: { type: 'user', userId: 'Utest1' },
    webhookEventId: id,
    deliveryContext: { isRedelivery: false },
    replyToken: 'rt',
    message: { type: 'text', id: '1', text, quoteToken: 'qt' },
  };
}

async function post(body: string, signature?: string) {
  return app.inject({
    method: 'POST',
    url: '/webhook',
    headers: {
      'content-type': 'application/json',
      ...(signature ? { 'x-line-signature': signature } : {}),
    },
    payload: body,
  });
}

beforeEach(() => addBulk.mockClear());
afterAll(async () => app.close());

describe('POST /webhook — signature', () => {
  it('401 เมื่อไม่มี header signature และไม่ enqueue', async () => {
    const body = makeBody([textEvent('e1')]);
    const res = await post(body);
    expect(res.statusCode).toBe(401);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('401 เมื่อ signature ผิด', async () => {
    const body = makeBody([textEvent('e2')]);
    const res = await post(body, computeLineSignature('secret-ผิด', body));
    expect(res.statusCode).toBe(401);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('200 เมื่อ signature ถูก และ enqueue ครบทุก event', async () => {
    const body = makeBody([textEvent('e3'), textEvent('e4')]);
    const res = await post(body, computeLineSignature(SECRET, body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, queued: 2 });
    expect(addBulk).toHaveBeenCalledTimes(1);
  });

  it('signature ต้องคำนวณจาก byte ดิบ — body ที่มีช่องว่างต่างกันต้องยังผ่าน', async () => {
    // ถ้า route ไปคำนวณจาก JSON.stringify(req.body) เทสต์นี้จะพัง
    const body = '{ "destination":"U1",\n  "events": [] }';
    const res = await post(body, computeLineSignature(SECRET, body));
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /webhook — เนื้อหา', () => {
  it('ตอบ 200 ให้ verify request ของ LINE (events ว่าง) และไม่ enqueue', async () => {
    const body = makeBody([]);
    const res = await post(body, computeLineSignature(SECRET, body));
    expect(res.statusCode).toBe(200);
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('ใช้ webhookEventId เป็น jobId เพื่อกันประมวลผลซ้ำ', async () => {
    const body = makeBody([textEvent('01JABC')]);
    await post(body, computeLineSignature(SECRET, body));
    const [jobs] = addBulk.mock.calls[0] as unknown as [Array<{ opts: { jobId: string } }>];
    expect(jobs[0]?.opts.jobId).toBe('01JABC');
  });

  it('ยังตอบ 200 (ไม่ 500) เมื่อ body ผิดรูปจนใช้ไม่ได้ — จะได้ไม่ให้ LINE retry เปล่าๆ', async () => {
    const body = JSON.stringify({ foo: 'bar' }); // ไม่มี events
    const res = await post(body, computeLineSignature(SECRET, body));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ignored: true });
    expect(addBulk).not.toHaveBeenCalled();
  });

  it('คืน 500 เมื่อ enqueue ล้มเหลว เพื่อให้ LINE retry ส่งมาใหม่', async () => {
    addBulk.mockRejectedValueOnce(new Error('redis ล่ม') as never);
    const body = makeBody([textEvent('e9')]);
    const res = await post(body, computeLineSignature(SECRET, body));
    expect(res.statusCode).toBe(500);
  });
});

describe('health', () => {
  it('/healthz ตอบ ok โดยไม่แตะ dependency', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('/readyz เช็ค postgres + redis', async () => {
    const res = await app.inject({ method: 'GET', url: '/readyz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, checks: { postgres: 'ok', redis: 'ok' } });
  });
});
