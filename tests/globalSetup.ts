import { execSync } from 'node:child_process';

const TEST_DB = 'postgresql://nami:nami@localhost:55432/nami_test?schema=public';

/**
 * รัน migration ลง DB สำหรับเทสต์ครั้งเดียวก่อนเริ่มทั้งชุด
 *
 * ใช้ DB จริง (postgres ใน docker) ไม่ใช่ mock เพราะสิ่งที่เราต้องพิสูจน์
 * คือทรานแซกชัน, unique constraint กันยิงซ้ำ และ FK — ของพวกนี้ mock แทนไม่ได้
 *
 * ถ้าต่อ DB ไม่ได้ จะไม่ทำให้ทั้งชุดพัง แค่ให้ integration test ข้ามตัวเอง
 */
export async function setup(): Promise<void> {
  try {
    execSync('npx prisma migrate deploy', {
      stdio: 'pipe',
      env: { ...process.env, DATABASE_URL: TEST_DB, DIRECT_URL: TEST_DB },
    });
    process.env.NAMI_TEST_DB_READY = '1';
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `\n[globalSetup] เตรียม DB สำหรับเทสต์ไม่ได้ — integration test จะถูกข้าม\n` +
        `  ${msg.split('\n').slice(0, 3).join(' ')}\n` +
        `  แก้ด้วย: docker compose up -d postgres\n`,
    );
  }
}
