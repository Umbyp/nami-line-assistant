import Fastify, { type FastifyBaseLogger, type FastifyInstance } from 'fastify';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { registerWebhookRoutes } from './routes.js';
import { registerHealthRoutes } from './health.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** body ดิบ เก็บไว้เพื่อคำนวณ signature (ห้ามใช้ body ที่ parse แล้ว) */
    rawBody?: Buffer;
  }
}

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    // pino Logger กับ FastifyBaseLogger ต่างกันแค่ field msgPrefix ที่ fastify ไม่ได้ใช้
    // cast ตรงนี้เพื่อให้ FastifyInstance คง generic ดีฟอลต์ไว้ (ไม่งั้น type ของ route ทุกตัวเพี้ยน)
    loggerInstance: logger as unknown as FastifyBaseLogger,
    // LINE ส่ง body ไม่ใหญ่ ตัดที่ 1MB กัน abuse
    bodyLimit: 1_048_576,
    // ตัด request ที่ค้างนานทิ้ง
    requestTimeout: 10_000,
    trustProxy: true,
  });

  /**
   * parser ตัวนี้ทำสองอย่างพร้อมกัน: เก็บ raw buffer ไว้ใน req.rawBody
   * แล้วค่อย JSON.parse — เพราะ signature ต้องคำนวณจาก byte ดิบเท่านั้น
   */
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body: Buffer, done) => {
      req.rawBody = body;
      if (body.length === 0) return done(null, {});
      try {
        done(null, JSON.parse(body.toString('utf8')));
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  await registerHealthRoutes(app);
  await registerWebhookRoutes(app);

  return app;
}

export async function startServer(): Promise<FastifyInstance> {
  const app = await buildServer();
  await app.listen({ port: env.PORT, host: '0.0.0.0' });
  return app;
}
