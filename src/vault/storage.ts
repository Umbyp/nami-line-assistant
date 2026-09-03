import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  CreateBucketCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

/**
 * client เดียวใช้ได้ทั้ง MinIO (dev) และ Cloudflare R2 (prod)
 * เพราะทั้งคู่พูด S3 API เหมือนกัน ต่างกันแค่ endpoint/forcePathStyle
 */
export const s3 = new S3Client({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  forcePathStyle: env.S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: env.S3_ACCESS_KEY_ID,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY,
  },
});

/** เรียกตอน boot เพื่อให้ dev ใหม่ไม่ต้องสร้าง bucket เอง (MinIO เท่านั้น — R2 สร้างจาก dashboard) */
export async function ensureBucketExists(): Promise<void> {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: env.S3_BUCKET }));
  } catch {
    try {
      await s3.send(new CreateBucketCommand({ Bucket: env.S3_BUCKET }));
      logger.info({ bucket: env.S3_BUCKET }, 'สร้าง bucket ให้แล้ว');
    } catch (err) {
      // R2 ไม่รองรับ CreateBucketCommand แบบเดียวกัน — ไม่ใช่เรื่องคอขาดบาดตาย ถ้า bucket มีอยู่แล้วจริง
      logger.debug({ err, bucket: env.S3_BUCKET }, 'สร้าง bucket ไม่สำเร็จ (อาจมีอยู่แล้ว)');
    }
  }
}

/** สร้าง key ที่ไม่ชนกันและไม่เดาง่าย เผื่อ bucket ถูกตั้ง public โดยไม่ได้ตั้งใจ */
export function makeStorageKey(chatId: string, originalName: string | null): string {
  const ext = originalName?.includes('.') ? originalName.slice(originalName.lastIndexOf('.')) : '';
  const random = crypto.randomBytes(16).toString('hex');
  return `vault/${chatId}/${random}${ext}`;
}

export async function uploadObject(
  key: string,
  body: Buffer,
  contentType: string,
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType,
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}

/**
 * URL ชั่วคราวให้ผู้ใช้เปิด/ดาวน์โหลดไฟล์
 * ไม่เก็บ URL ถาวรใน DB เพราะ credential เปลี่ยนได้และ URL ควรหมดอายุเพื่อความปลอดภัย
 */
export async function getSignedDownloadUrl(key: string, expiresInSec = 3600): Promise<string> {
  return getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: env.S3_BUCKET, Key: key }),
    { expiresIn: expiresInSec },
  );
}
