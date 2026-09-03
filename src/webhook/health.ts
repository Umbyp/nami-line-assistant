import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma.js';
import { redis } from '../lib/redis.js';
import { lineClient } from '../line/client.js';
import { env } from '../config/env.js';
import { isLlmConfigured } from '../llm/client.js';
import { isEmbeddingEnabled } from '../llm/embed.js';

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

    /**
     * ตรวจการตั้งค่า LLM: key ใช้ได้ไหม เครดิตเหลือเท่าไหร่ โมเดลที่ตั้งไว้มีจริงไหม
     * ไม่ยิง completion จริงเพื่อไม่ให้เสียเงินตอนเช็ค — ถ้าอยากยิงจริงใส่ ?probe=1
     */
    app.get('/debug/llm-config', async (req, reply) => {
      const problems: string[] = [];
      const result: Record<string, unknown> = {
        configured: isLlmConfigured(),
        embeddingEnabled: isEmbeddingEnabled(),
        baseUrl: env.OPENROUTER_BASE_URL,
        models: {
          text: env.LLM_MODEL_TEXT,
          vision: env.LLM_MODEL_VISION,
          embed: env.LLM_MODEL_EMBED,
        },
        embeddingDimensions: env.EMBEDDING_DIMENSIONS,
        nluConfidenceThreshold: env.NLU_CONFIDENCE_THRESHOLD,
      };

      if (!isLlmConfigured()) {
        problems.push('ยังไม่ได้ตั้ง OPENROUTER_API_KEY → NLU และการอ่านรูปจะใช้ไม่ได้');
        return reply.send({ ok: false, ...result, problems });
      }

      const auth = { Authorization: `Bearer ${env.OPENROUTER_API_KEY}` };

      // ── key ใช้ได้ไหม + เครดิต ──
      try {
        const r = await fetch(`${env.OPENROUTER_BASE_URL}/key`, { headers: auth });
        if (!r.ok) {
          problems.push(`เรียก /key ไม่สำเร็จ (HTTP ${r.status}) → key ผิดหรือถูกเพิกถอน`);
        } else {
          const body = (await r.json()) as { data?: Record<string, unknown> };
          const d = body.data ?? {};
          result.key = {
            label: d['label'],
            usageUsd: d['usage'],
            limitUsd: d['limit'],
            limitRemainingUsd: d['limit_remaining'],
            isFreeTier: d['is_free_tier'],
          };
          if (d['limit'] == null) {
            problems.push(
              'key นี้ไม่ได้ตั้ง spend limit → ถ้า key รั่วจะถูกใช้ได้ไม่จำกัด ' +
                'ตั้งได้ที่ https://openrouter.ai/settings/limits',
            );
          }
          const remaining = d['limit_remaining'];
          if (typeof remaining === 'number' && remaining <= 0) {
            problems.push('เครดิตหมด → ทุก request จะถูกปฏิเสธ');
          }
        }
      } catch (err) {
        problems.push(`ต่อ OpenRouter ไม่ได้: ${(err as Error).message}`);
      }

      // ── โมเดลที่ตั้งไว้มีจริงไหม (สะกดผิดคือสาเหตุพังที่พบบ่อยที่สุด) ──
      try {
        const r = await fetch(`${env.OPENROUTER_BASE_URL}/models`, { headers: auth });
        const body = (await r.json()) as { data?: Array<{ id: string; architecture?: { input_modalities?: string[] } }> };
        const all = body.data ?? [];
        const byId = new Map(all.map((m) => [m.id, m]));

        for (const [tier, id] of [
          ['text', env.LLM_MODEL_TEXT],
          ['vision', env.LLM_MODEL_VISION],
        ] as const) {
          const m = byId.get(id);
          if (!m) {
            problems.push(`โมเดล ${tier} = "${id}" ไม่มีอยู่ใน OpenRouter (สะกดผิด?)`);
          } else if (tier === 'vision' && !(m.architecture?.input_modalities ?? []).includes('image')) {
            problems.push(`โมเดล vision = "${id}" รับ input เป็นรูปไม่ได้ → ฟีเจอร์ตั้งเตือนจากรูปจะพัง`);
          }
        }
        result.modelCatalogSize = all.length;
      } catch (err) {
        problems.push(`ดึงรายการโมเดลไม่ได้: ${(err as Error).message}`);
      }

      // ── ยิงจริงเมื่อขอมาเท่านั้น (มีค่าใช้จ่าย) ──
      if ((req.query as Record<string, unknown>)?.['probe'] === '1') {
        const { completeStructured } = await import('../llm/chat.js');
        const { z } = await import('zod');
        const probe = await completeStructured({
          name: 'probe',
          schema: z.object({ ok: z.boolean(), thai: z.string() }),
          system: 'ตอบเป็น JSON: {"ok": true, "thai": "สวัสดี"}',
          user: 'ทดสอบ',
          maxTokens: 64,
        });
        result.probe = probe.ok
          ? { ok: true, data: probe.data, costUsd: probe.costUsd, model: probe.model }
          : { ok: false, reason: probe.reason, detail: probe.detail };
        if (!probe.ok) problems.push(`ยิงทดสอบไม่ผ่าน: ${probe.reason} — ${probe.detail}`);
      }

      return reply.send({ ok: problems.length === 0, ...result, problems });
    });
  }
}
