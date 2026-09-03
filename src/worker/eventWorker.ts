import { Worker, type Job } from 'bullmq';
import type { webhook } from '@line/bot-sdk';
import { QUEUE, QUEUE_PREFIX } from '../queue/queues.js';
import type { EventJobData } from '../queue/types.js';
import { createRedis } from '../lib/redis.js';
import { logger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { handleEvent } from '../handlers/index.js';

/**
 * กัน event ซ้ำสองชั้น:
 *   ชั้นที่ 1 — jobId = webhookEventId (BullMQ) กันซ้ำในช่วงที่ job ยังอยู่ใน Redis
 *   ชั้นที่ 2 — ตาราง processed_events กันซ้ำถาวร กรณี LINE retry หลัง job หมดอายุแล้ว
 *
 * บันทึกลง processed_events "หลัง" ทำงานสำเร็จเท่านั้น
 * ไม่งั้น job ที่ fail แล้ว retry จะถูกมองว่าทำไปแล้วและข้ามทิ้ง
 */
async function alreadyProcessed(webhookEventId: string | undefined): Promise<boolean> {
  if (!webhookEventId) return false;
  const row = await prisma.processedEvent.findUnique({ where: { webhookEventId } });
  return row !== null;
}

async function markProcessed(webhookEventId: string | undefined): Promise<void> {
  if (!webhookEventId) return;
  await prisma.processedEvent
    .create({ data: { webhookEventId } })
    // แข่งกันเขียนพร้อมกันได้ — ซ้ำก็ไม่เป็นไร
    .catch(() => undefined);
}

export function createEventWorker(): Worker<EventJobData> {
  const worker = new Worker<EventJobData>(
    QUEUE.events,
    async (job: Job<EventJobData>) => {
      const event = job.data.event;
      // webhookEventId เป็น ULID ที่ LINE การันตีว่า unique ต่อ event
      const webhookEventId = event.webhookEventId;

      const log = logger.child({ jobId: job.id, eventType: event.type });

      if (await alreadyProcessed(webhookEventId)) {
        log.info('event นี้ทำไปแล้ว — ข้าม');
        return;
      }

      const startedAt = Date.now();
      await handleEvent(event);
      await markProcessed(webhookEventId);

      log.info(
        {
          handleMs: Date.now() - startedAt,
          // latency รวมตั้งแต่ webhook เข้ามาจนประมวลผลจบ
          totalMs: Date.now() - new Date(job.data.receivedAt).getTime(),
        },
        'ประมวลผล event สำเร็จ',
      );
    },
    {
      connection: createRedis(),
      prefix: QUEUE_PREFIX,
      // event หลายอันจากคนละแชทประมวลผลขนานกันได้
      concurrency: 10,
      // reply token อายุสั้น ถ้าค้างนานกว่านี้ก็ reply ไม่ทันแล้ว
      lockDuration: 60_000,
    },
  );

  worker.on('failed', (job, err) => {
    logger.error({ jobId: job?.id, attempt: job?.attemptsMade, err }, 'event job ล้มเหลว');
  });

  return worker;
}
