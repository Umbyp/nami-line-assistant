import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { verifyLineSignature } from '../line/signature.js';
import { eventsQueue } from '../queue/queues.js';
import { EVENT_JOB, type EventJobData } from '../queue/types.js';

/**
 * เช็คแค่โครงนอกสุด ไม่ validate ตัว event ลึกๆ
 * เพราะ LINE เพิ่ม event type ใหม่ได้เรื่อยๆ — ถ้า schema เข้มเกินจะตกทั้ง batch
 * การ validate รายชนิดไปทำใน handler
 */
const webhookBodySchema = z.object({
  destination: z.string().optional(),
  events: z.array(z.record(z.unknown())),
});

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhook', async (req, reply) => {
    const raw = req.rawBody ?? Buffer.alloc(0);
    const signature = req.headers['x-line-signature'] as string | undefined;

    // ── 1. verify signature ────────────────────────────────────
    if (env.LINE_SKIP_SIGNATURE_VERIFY) {
      req.log.warn('ข้าม signature verification (dev mode)');
    } else if (!verifyLineSignature(env.LINE_CHANNEL_SECRET, raw, signature)) {
      req.log.warn({ hasSignature: Boolean(signature) }, 'signature ไม่ถูกต้อง');
      // 401 ไม่ใช่ 200 — request นี้ไม่ได้มาจาก LINE
      return reply.code(401).send({ ok: false, error: 'invalid signature' });
    }

    // ── 2. parse ────────────────────────────────────────────────
    const parsed = webhookBodySchema.safeParse(req.body);
    if (!parsed.success) {
      req.log.warn({ issues: parsed.error.issues }, 'webhook body ผิดรูป');
      // ตอบ 200 เพื่อไม่ให้ LINE retry ของที่ยังไงก็ parse ไม่ได้
      return reply.code(200).send({ ok: true, ignored: true });
    }

    const { events } = parsed.data;

    // LINE ยิง verify request มาพร้อม events: [] — ต้องตอบ 200
    if (events.length === 0) {
      return reply.code(200).send({ ok: true });
    }

    // ── 3. enqueue ทั้ง batch แล้วจบ request ────────────────────
    // ห้ามเรียก LLM / DB หนักๆ ที่นี่ เพราะต้องตอบ 200 ภายใน ~1 วินาที
    const receivedAt = new Date().toISOString();
    try {
      await eventsQueue.addBulk(
        events.map((event, i) => {
          const webhookEventId = event['webhookEventId'];
          return {
            name: EVENT_JOB,
            data: { event, receivedAt } as unknown as EventJobData,
            opts: {
              // jobId = webhookEventId → LINE retry ส่ง event เดิมมาซ้ำก็ไม่ประมวลผลสองรอบ
              // (BullMQ ปฏิเสธ job ที่ jobId ซ้ำเงียบๆ)
              jobId: typeof webhookEventId === 'string' ? webhookEventId : `${receivedAt}:${i}`,
            },
          };
        }),
      );
    } catch (err) {
      req.log.error({ err }, 'enqueue ไม่สำเร็จ');
      // คืน 500 ให้ LINE retry เอง ดีกว่ากลืน event ทิ้ง
      return reply.code(500).send({ ok: false });
    }

    req.log.info({ count: events.length }, 'รับ webhook แล้ว');
    return reply.code(200).send({ ok: true, queued: events.length });
  });
}
