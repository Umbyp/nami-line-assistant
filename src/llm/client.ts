import OpenAI from 'openai';
import { env } from '../config/env.js';

/**
 * OpenRouter พูดภาษาเดียวกับ OpenAI API เลยใช้ openai SDK ชี้ baseURL ไปที่มันได้
 * ข้อดี: retry/timeout/typing ได้ของ SDK ฟรี และถ้าจะย้าย provider ทีหลังก็แก้ที่ไฟล์นี้ไฟล์เดียว
 */
export const llm = new OpenAI({
  apiKey: env.OPENROUTER_API_KEY,
  baseURL: env.OPENROUTER_BASE_URL,
  // SDK retry เองสำหรับ 429/5xx — ตั้ง 2 ครั้งพอ เพราะ BullMQ มี retry ชั้นนอกอีก
  maxRetries: 2,
  timeout: 60_000,
  defaultHeaders: {
    'HTTP-Referer': env.OPENROUTER_APP_URL,
    'X-Title': env.OPENROUTER_APP_NAME,
  },
});

export function isLlmConfigured(): boolean {
  return env.OPENROUTER_API_KEY.length > 0;
}

/**
 * OpenRouter แนบ usage.cost (USD จริงของ request นั้น) มาให้ ซึ่งไม่มีใน type ของ openai SDK
 * ดึงออกมาแบบปลอดภัย — ถ้าไม่มีให้ถือเป็น 0 อย่าให้ทั้ง job พังเพราะ field เสริม
 */
export function readCostUsd(usage: unknown): number {
  if (usage && typeof usage === 'object' && 'cost' in usage) {
    const c = (usage as { cost: unknown }).cost;
    if (typeof c === 'number' && Number.isFinite(c)) return c;
  }
  return 0;
}

export function readTokens(usage: unknown): number {
  if (usage && typeof usage === 'object' && 'total_tokens' in usage) {
    const t = (usage as { total_tokens: unknown }).total_tokens;
    if (typeof t === 'number' && Number.isFinite(t)) return t;
  }
  return 0;
}
