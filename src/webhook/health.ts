import type { FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { lineClient } from '../line/client.js';

export async function registerHealthRoutes(app: FastifyInstance): Promise<void> {
  /** liveness — ต้องเบาที่สุด ไม่แตะ dependency */
  app.get('/healthz', async () => ({ ok: true }));

  /** readiness — เช็ค dependency จริง */
  app.get('/readyz', async (_req, reply) => {
    const checks: Record<string, string> = {};
    let ok = true;

    try {
      await prisma.$queryRaw`SELECT 1`;
      checks.postgres = 'ok';
    } catch (err) {
      checks.postgres = `fail: ${(err as Error).message}`;
      ok = false;
    }

    try {
      await redis.ping();
      checks.redis = 'ok';
    } catch (err) {
      checks.redis = `fail: ${(err as Error).message}`;
      ok = false;
    }

    return reply.code(ok ? 200 : 503).send({ ok, checks });
  });

  /**
   * ตัวช่วยตรวจว่าตั้งค่า LINE OA ถูกไหม (เปิดเฉพาะตอนไม่ใช่ production)
   * ตอบเป็น checklist ภาษาไทยบอกว่าต้องไปแก้อะไรที่ไหน
   */
  if (env.NODE_ENV !== 'production') {
    app.get('/debug/line-config', async (_req, reply) => {
      const result: Record<string, unknown> = {};
      const problems: string[] = [];
      const notes: string[] = [];

      // ── access token ใช้ได้จริงไหม ──
      try {
        const info = await lineClient.getBotInfo();
        result.bot = {
          basicId: info.basicId,
          displayName: info.displayName,
          chatMode: info.chatMode,
          markAsReadMode: info.markAsReadMode,
        };
        // chatMode 'bot' = ตอบด้วย Messaging API (สิ่งที่เราต้องการ)
        // chatMode 'chat' = เปิดโหมดแชทกับคน — auto-reply/greeting จะแทรกข้อความของนามิ
        if (info.chatMode !== 'bot') {
          problems.push(
            'chatMode ไม่ใช่ "bot" → ไปที่ LINE OA Manager > การตั้งค่า > การตอบกลับ ' +
              'เลือก "Bot" และปิด "การตอบกลับอัตโนมัติ" กับ "ข้อความต้อนรับ" ถ้าไม่ต้องการ',
          );
        }
      } catch (err) {
        problems.push(
          `เรียก getBotInfo ไม่สำเร็จ (${(err as Error).message}) → LINE_CHANNEL_ACCESS_TOKEN ` +
            'ผิดหรือหมดอายุ ออก token ใหม่ที่ LINE Developers Console > Messaging API',
        );
      }

      // ── webhook URL ตั้งไว้ถูกไหม ──
      try {
        const wh = await lineClient.getWebhookEndpoint();
        result.webhook = { endpoint: wh.endpoint, active: wh.active };
        if (!wh.active) {
          problems.push('Webhook ปิดอยู่ → เปิด "Use webhook" ใน LINE Developers Console');
        }
        if (!wh.endpoint?.endsWith('/webhook')) {
          notes.push(`endpoint ปัจจุบันคือ ${wh.endpoint} — ปกติต้องลงท้ายด้วย /webhook`);
        }

        // ── ยิงทดสอบไปที่ endpoint จริง ──
        try {
          const test = await lineClient.testWebhookEndpoint({});
          result.webhookTest = {
            success: test.success,
            statusCode: test.statusCode,
            reason: test.reason,
            detail: test.detail,
          };
          if (!test.success) {
            problems.push(
              `LINE ยิงทดสอบมาที่ webhook ไม่สำเร็จ (${test.reason}) → ` +
                'เช็คว่า ngrok ยังรันอยู่ และ URL ใน console ตรงกับ ngrok ตัวปัจจุบัน',
            );
          }
        } catch (err) {
          notes.push(`testWebhookEndpoint ไม่สำเร็จ: ${(err as Error).message}`);
        }
      } catch (err) {
        problems.push(
          `เรียก getWebhookEndpoint ไม่สำเร็จ (${(err as Error).message}) → ` +
            'ยังไม่ได้ตั้ง Webhook URL ใน LINE Developers Console',
        );
      }

      // ── สิ่งที่ API เช็คแทนไม่ได้ ต้องดูด้วยตาเอง ──
      const manualChecklist = [
        'LINE OA Manager > การตั้งค่า > การตอบกลับ: ปิด "การตอบกลับอัตโนมัติ" (ไม่งั้นจะมีข้อความอื่นตอบทับนามิ)',
        'LINE OA Manager > การตั้งค่า > การตอบกลับ: เปิด "Webhook"',
        'LINE OA Manager > การตั้งค่า > บัญชี: เปิด "อนุญาตให้บอทเข้าร่วมแชทกลุ่ม" (จำเป็นสำหรับฟีเจอร์กลุ่ม)',
        'LINE Developers Console > Messaging API: เปิด "Use webhook"',
      ];

      return reply.send({
        ok: problems.length === 0,
        ...result,
        problems,
        notes,
        manualChecklist,
        env: {
          signatureVerify: env.LINE_SKIP_SIGNATURE_VERIFY ? 'ข้ามอยู่ (dev)' : 'เปิดอยู่',
          timezone: env.APP_TIMEZONE,
        },
      });
    });
  }
}
