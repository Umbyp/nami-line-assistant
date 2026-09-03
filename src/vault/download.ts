import { lineBlobClient } from '../line/client.js';
import { logger } from '../lib/logger.js';

export interface DownloadedContent {
  buffer: Buffer;
  mime: string;
}

/**
 * ดาวน์โหลด content (รูป/ไฟล์/วิดีโอ/เสียง) จาก LINE ทันทีที่ได้รับ
 *
 * ต้องทำใน job แรกเท่านั้น — ไฟล์ใน LINE มีอายุจำกัด (ประมาณไม่กี่วัน)
 * ถ้าค้างไว้แล้วค่อยดาวน์โหลดทีหลัง อาจได้ 410 Gone
 */
export async function downloadLineContent(messageId: string): Promise<DownloadedContent> {
  const stream = await lineBlobClient.getMessageContent(messageId);
  const chunks: Buffer[] = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }

  const buffer = Buffer.concat(chunks);

  // LINE SDK ไม่ส่ง content-type กลับมาตรงๆ ผ่าน stream — เดาจาก magic bytes เอาไม่ได้ครบทุกกรณี
  // ดังนั้นชั้นบน (message handler) ต้องส่ง mime ที่รู้จากชนิด message (image/video/audio) มาเสริม
  // ฟังก์ชันนี้คืนแค่ buffer ล้วน
  logger.debug({ messageId, bytes: buffer.length }, 'ดาวน์โหลดจาก LINE สำเร็จ');
  return { buffer, mime: 'application/octet-stream' };
}
