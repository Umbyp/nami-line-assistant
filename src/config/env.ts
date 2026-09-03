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

  // ── OpenRouter (OpenAI-compatible) ──
  // ใช้ provider เดียวทั้ง chat และ embeddings
  OPENROUTER_API_KEY: z.string().default(''),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  // OpenRouter ขอให้ส่ง 2 header นี้เพื่อระบุแอป (ใช้ใน dashboard/leaderboard)
  OPENROUTER_APP_URL: z.string().default('https://github.com/nami-line-assistant'),
  OPENROUTER_APP_NAME: z.string().default('Nami LINE Assistant'),

  // โมเดลแยกตามงาน — วัดผลจริงแล้วว่าตัวถูกอ่านตารางในรูปพลาด (ดู README)
  LLM_MODEL_TEXT: z.string().default('google/gemini-2.5-flash-lite'),
  LLM_MODEL_VISION: z.string().default('google/gemini-2.5-flash'),
  LLM_MODEL_EMBED: z.string().default('openai/text-embedding-3-small'),

  // ต้องตรงกับ vector(N) ใน migration ของ vault_items ไม่งั้น insert จะพัง
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(1536),

  // ถ้า confidence จาก NLU ต่ำกว่านี้ → ถามผู้ใช้กลับ ห้ามเดา
  NLU_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),

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
