import { defineConfig } from 'vitest/config';

const TEST_DB = 'postgresql://nami:nami@localhost:55432/nami_test?schema=public';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // integration test แตะ DB จริง จึงต้องรันทีละไฟล์ ไม่ให้ข้อมูลชนกัน
    fileParallelism: false,
    globalSetup: ['tests/globalSetup.ts'],
    env: {
      // รันเทสต์บน TZ ที่ไม่ใช่ไทย เพื่อพิสูจน์ว่าโค้ดไม่แอบพึ่ง timezone ของเครื่อง
      TZ: 'UTC',
      NODE_ENV: 'test',
      LOG_LEVEL: 'error',
      LINE_CHANNEL_SECRET: 'test-secret',
      LINE_CHANNEL_ACCESS_TOKEN: 'test-token',
      DATABASE_URL: TEST_DB,
      DIRECT_URL: TEST_DB,
      REDIS_URL: 'redis://localhost:6379',
      S3_ENDPOINT: 'http://localhost:9000',
      S3_BUCKET: 'nami-vault-test',
      S3_ACCESS_KEY_ID: 'test',
      S3_SECRET_ACCESS_KEY: 'test',
      APP_TIMEZONE: 'Asia/Bangkok',
      OPENROUTER_API_KEY: 'test-openrouter-key',
      NLU_CONFIDENCE_THRESHOLD: '0.6',
    },
  },
});
