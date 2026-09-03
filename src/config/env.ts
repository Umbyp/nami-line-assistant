import { z } from 'zod';

/**
 * validate env ตอน boot ครั้งเดียว — ถ้าขาดตัวไหนให้ตายทันที
 * ดีกว่าไปพังกลางทางตอนผู้ใช้กำลังคุยกับนามิ
 */
const boolish = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  PORT: z.coerce.number().int().positive().default(3000),

  LINE_CHANNEL_SECRET: z.string().min(1, 'ต้องตั้ง LINE_CHANNEL_SECRET'),
  LINE_CHANNEL_ACCESS_TOKEN: z.string().min(1, 'ต้องตั้ง LINE_CHANNEL_ACCESS_TOKEN'),
  LINE_SKIP_SIGNATURE_VERIFY: boolish.default('false'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_FORCE_PATH_STYLE: boolish.default('true'),

  ANTHROPIC_API_KEY: z.string().default(''),
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-5'),

  VOYAGE_API_KEY: z.string().default(''),
  VOYAGE_MODEL: z.string().default('voyage-3'),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1024),

  APP_TIMEZONE: z.string().default('Asia/Bangkok'),

  DEFAULT_QUIET_HOURS_START: z.coerce.number().int().min(0).max(1439).default(1320),
  DEFAULT_QUIET_HOURS_END: z.coerce.number().int().min(0).max(1439).default(420),

  PUSH_SOFT_LIMIT_FREE: z.coerce.number().int().nonnegative().default(200),
  PUSH_SOFT_LIMIT_PRO: z.coerce.number().int().nonnegative().default(5000),
  STORAGE_SOFT_LIMIT_FREE_MB: z.coerce.number().int().nonnegative().default(200),
  STORAGE_SOFT_LIMIT_PRO_MB: z.coerce.number().int().nonnegative().default(5000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
    .join('\n');
  // เขียนลง stderr ตรงๆ เพราะ logger ยังไม่ถูก init ตอนนี้
  console.error(`[nami] env ไม่ผ่านการตรวจสอบ:\n${issues}\n\nดู .env.example เป็นตัวอย่าง`);
  process.exit(1);
}

export const env = parsed.data;

// กันเท้าตัวเอง: production ห้ามข้าม signature verify
if (env.NODE_ENV === 'production' && env.LINE_SKIP_SIGNATURE_VERIFY) {
  console.error('[nami] LINE_SKIP_SIGNATURE_VERIFY=true บน production ไม่ได้');
  process.exit(1);
}

export type Env = typeof env;
