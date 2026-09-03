import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * integration test ของ scheduler — แตะ Postgres จริง
 * mock เฉพาะ LINE API และ BullMQ เพราะสิ่งที่ต้องพิสูจน์คือ
 * การ claim แบบ atomic, unique constraint และทรานแซกชัน — mock แทนไม่ได้
 */
// ประกาศชนิดพารามิเตอร์ตรงๆ (to, messages, opts) ไม่งั้น TS จะ infer จาก
// implementation เริ่มต้น (ไม่มีพารามิเตอร์เลย) แล้วปฏิเสธการอ่าน mock.calls[i][1] ทีหลัง
const pushMock = vi.fn<
  (to: string, messages: unknown[], opts?: unknown) => Promise<{ sent: boolean; reason?: string }>
>(async () => ({ sent: true }));

vi.mock('../src/line/push.js', () => ({
  push: (...args: unknown[]) => pushMock(...(args as [string, unknown[], unknown?])),
}));

const queueAdd = vi.fn(
  async (_name: string, _data: unknown, _opts: { jobId: string; delay: number }) => ({ id: 'job' }),
);
const getJob = vi.fn(async (_id: string) => null);

vi.mock('../src/queue/queues.js', () => ({
  QUEUE: { events: 'events', fire: 'reminder-fire', scheduler: 'scheduler' },
  QUEUE_PREFIX: 'nami',
  eventsQueue: { addBulk: vi.fn() },
  fireQueue: { add: queueAdd, getJob },
  schedulerQueue: { add: vi.fn() },
  closeQueues: vi.fn(),
}));

const { prisma } = await import('../src/lib/prisma.js');
const { dbReady, resetDb, seedChatAndUser } = await import('./helpers/db.js');
const { fireOccurrence, recoverStuckOccurrences } = await import('../src/scheduler/fire.js');
const { enqueueDueOccurrences, runSweep } = await import('../src/scheduler/enqueue.js');
const {
  createOnceReminder,
  createRecurringReminder,
  snoozeOccurrence,
  markOccurrenceDone,
  cancelReminder,
} = await import('../src/reminders/service.js');

const d = dbReady ? describe : describe.skip;

const CHAT = 'Utest-sched-00000000000000000001';
const USER = 'Utest-scheduser-0000000000000001';
let chatId = '';

async function occurrencesOf(reminderId: string) {
  return prisma.reminderOccurrence.findMany({
    where: { reminderId },
    orderBy: { fireAtUtc: 'asc' },
  });
}

d('scheduler — การยิงและกันยิงซ้ำ', () => {
  beforeEach(async () => {
    await resetDb();
    ({ chatId } = await seedChatAndUser({ lineChatId: CHAT, lineUserId: USER }));
    pushMock.mockClear();
    pushMock.mockResolvedValue({ sent: true });
    queueAdd.mockClear();
    getJob.mockClear();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  const past = new Date(Date.now() - 60_000);

  it('ยิงสำเร็จ → occurrence เป็น sent และ push ถูกเรียกครั้งเดียว', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'กินยา', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);

    const out = await fireOccurrence(occ!.id);
    expect(out.ok).toBe(true);
    expect(pushMock).toHaveBeenCalledTimes(1);

    const after = await prisma.reminderOccurrence.findUnique({ where: { id: occ!.id } });
    expect(after?.status).toBe('sent');
    expect(after?.sentAt).not.toBeNull();
    expect(after?.attempt).toBe(1);
  });

  it('เตือนครั้งเดียวที่ยิงแล้ว → reminder เป็น done ไม่มี nextFireAt', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);
    await fireOccurrence(occ!.id);

    const after = await prisma.reminder.findUnique({ where: { id: r.id } });
    expect(after?.status).toBe('done');
    expect(after?.nextFireAtUtc).toBeNull();
  });

  it('ยิง occurrence เดิมซ้ำ → push ไม่ถูกเรียกอีก (หัวใจของ idempotency)', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);

    await fireOccurrence(occ!.id);
    const second = await fireOccurrence(occ!.id);

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.skipped).toBe('already_handled');
  });

  it('ยิงพร้อมกัน 5 ตัว → push ถูกเรียกครั้งเดียว (claim แบบ atomic)', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);

    const results = await Promise.all(
      Array.from({ length: 5 }, () => fireOccurrence(occ!.id)),
    );

    expect(pushMock).toHaveBeenCalledTimes(1);
    const skipped = results.filter((x) => x.ok && x.skipped === 'already_handled');
    expect(skipped).toHaveLength(4);
  });

  it('การเตือนที่ถูกยกเลิกแล้ว → ไม่ยิง และ occurrence เป็น skipped', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);
    // ยกเลิกทำให้ occurrence เป็น skipped อยู่แล้ว จึง claim ไม่ได้
    await cancelReminder(r.id, chatId);

    const out = await fireOccurrence(occ!.id);
    expect(pushMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
  });

  it('แชทถูกปิด (unfollow) → ไม่ยิง occurrence เป็น skipped', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);
    await prisma.chat.update({ where: { id: chatId }, data: { isActive: false } });

    const out = await fireOccurrence(occ!.id);
    expect(pushMock).not.toHaveBeenCalled();
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.skipped).toBe('chat_inactive');

    const after = await prisma.reminderOccurrence.findUnique({ where: { id: occ!.id } });
    expect(after?.status).toBe('skipped');
  });
});

d('scheduler — เมื่อยิงไม่สำเร็จ', () => {
  beforeEach(async () => {
    await resetDb();
    ({ chatId } = await seedChatAndUser({ lineChatId: CHAT, lineUserId: USER }));
    pushMock.mockClear();
    queueAdd.mockClear();
  });

  const past = new Date(Date.now() - 60_000);

  it('api_error ครั้งแรก → กลับเป็น pending เพื่อ retry', async () => {
    pushMock.mockResolvedValue({ sent: false, reason: 'api_error' });
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);

    const out = await fireOccurrence(occ!.id);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.willRetry).toBe(true);

    const after = await prisma.reminderOccurrence.findUnique({ where: { id: occ!.id } });
    expect(after?.status).toBe('pending');
    expect(after?.attempt).toBe(1);
    expect(after?.claimedAt).toBeNull();
    expect(after?.lastError).toBe('api_error');
  });

  it('พลาดครบ 3 ครั้ง → failed ไม่ retry อีก', async () => {
    pushMock.mockResolvedValue({ sent: false, reason: 'api_error' });
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);

    await fireOccurrence(occ!.id);
    await fireOccurrence(occ!.id);
    const third = await fireOccurrence(occ!.id);

    expect(pushMock).toHaveBeenCalledTimes(3);
    expect(third.ok).toBe(false);
    if (!third.ok) expect(third.willRetry).toBe(false);

    const after = await prisma.reminderOccurrence.findUnique({ where: { id: occ!.id } });
    expect(after?.status).toBe('failed');
    expect(after?.attempt).toBe(3);
  });

  it('โควตา push หมด → ข้ามเลย ไม่ retry (retry ไปก็เท่านั้น)', async () => {
    pushMock.mockResolvedValue({ sent: false, reason: 'quota_exceeded' });
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);

    const out = await fireOccurrence(occ!.id);
    expect(out.ok).toBe(true);

    const after = await prisma.reminderOccurrence.findUnique({ where: { id: occ!.id } });
    expect(after?.status).toBe('skipped');
    expect(after?.lastError).toContain('quota_exceeded');
  });
});

d('scheduler — กู้แถวที่ค้าง (process ตายกลางทาง)', () => {
  beforeEach(async () => {
    await resetDb();
    ({ chatId } = await seedChatAndUser({ lineChatId: CHAT, lineUserId: USER }));
    pushMock.mockClear();
    pushMock.mockResolvedValue({ sent: true });
  });

  const past = new Date(Date.now() - 60_000);

  it('แถวที่ค้างในสถานะ sending นานเกินกำหนด → กลับเป็น pending', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);

    // จำลอง process ตายหลัง claim
    await prisma.reminderOccurrence.update({
      where: { id: occ!.id },
      data: { status: 'sending', claimedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const recovered = await recoverStuckOccurrences(5 * 60_000);
    expect(recovered).toBe(1);

    const after = await prisma.reminderOccurrence.findUnique({ where: { id: occ!.id } });
    expect(after?.status).toBe('pending');
    expect(after?.claimedAt).toBeNull();

    // แล้วยิงได้จริง
    await fireOccurrence(occ!.id);
    expect(pushMock).toHaveBeenCalledTimes(1);
  });

  it('แถวที่เพิ่ง claim ไม่ถูกแตะ (ยังกำลังทำงานอยู่)', async () => {
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: past });
    const [occ] = await occurrencesOf(r.id);
    await prisma.reminderOccurrence.update({
      where: { id: occ!.id },
      data: { status: 'sending', claimedAt: new Date() },
    });

    expect(await recoverStuckOccurrences(5 * 60_000)).toBe(0);
    const after = await prisma.reminderOccurrence.findUnique({ where: { id: occ!.id } });
    expect(after?.status).toBe('sending');
  });
});

d('scheduler — enqueue', () => {
  beforeEach(async () => {
    await resetDb();
    ({ chatId } = await seedChatAndUser({ lineChatId: CHAT, lineUserId: USER }));
    queueAdd.mockClear();
  });

  it('ใช้ occurrence id เป็น jobId เพื่อกัน job ซ้ำ', async () => {
    const soon = new Date(Date.now() + 10 * 60_000);
    const r = await createOnceReminder({ chatId, createdBy: USER, title: 'x', dueAtUtc: soon });
    const [occ] = await occurrencesOf(r.id);

    await enqueueDueOccurrences();

    expect(queueAdd).toHaveBeenCalledTimes(1);
    const opts = queueAdd.mock.calls[0]?.[2];
    expect(opts?.jobId).toBe(occ!.id);
    expect(opts?.delay).toBeGreaterThan(0);
  });

  it('occurrence ที่เลยเวลาแล้ว → delay = 0 ยิงทันที', async () => {
    await createOnceReminder({
      chatId, createdBy: USER, title: 'x', dueAtUtc: new Date(Date.now() - 5 * 60_000),
    });
    const out = await enqueueDueOccurrences();
    expect(out.overdue).toBe(1);
    expect(queueAdd.mock.calls[0]?.[2]?.delay).toBe(0);
  });

  it('occurrence ที่ไกลเกิน horizon 1 ชม. → ยังไม่ enqueue', async () => {
    await createOnceReminder({
      chatId, createdBy: USER, title: 'x', dueAtUtc: new Date(Date.now() + 3 * 3_600_000),
    });
    const out = await enqueueDueOccurrences();
    expect(out.enqueued).toBe(0);
    expect(queueAdd).not.toHaveBeenCalled();
  });

  it('ไม่ enqueue ของแชทที่ถูกปิด หรือการเตือนที่ยกเลิกแล้ว', async () => {
    const soon = new Date(Date.now() + 10 * 60_000);
    const cancelled = await createOnceReminder({ chatId, createdBy: USER, title: 'a', dueAtUtc: soon });
    await cancelReminder(cancelled.id, chatId);

    const other = await prisma.chat.create({
      data: { lineId: 'Cinactive-000000000000000000001', type: 'group', isActive: false },
    });
    await createOnceReminder({ chatId: other.id, createdBy: USER, title: 'b', dueAtUtc: soon });

    const out = await enqueueDueOccurrences();
    expect(out.enqueued).toBe(0);
  });

  it('runSweep กู้แถวค้างแล้ว enqueue ในรอบเดียว', async () => {
    const r = await createOnceReminder({
      chatId, createdBy: USER, title: 'x', dueAtUtc: new Date(Date.now() - 60_000),
    });
    const [occ] = await occurrencesOf(r.id);
    await prisma.reminderOccurrence.update({
      where: { id: occ!.id },
      data: { status: 'sending', claimedAt: new Date(Date.now() - 10 * 60_000) },
    });

    const out = await runSweep();
    expect(out.recovered).toBe(1);
    expect(out.enqueued).toBe(1);
  });
});

d('scheduler — การเตือนซ้ำ', () => {
  beforeEach(async () => {
    await resetDb();
    ({ chatId } = await seedChatAndUser({ lineChatId: CHAT, lineUserId: USER }));
    pushMock.mockClear();
    pushMock.mockResolvedValue({ sent: true });
    queueAdd.mockClear();
  });

  it('สร้างการเตือนซ้ำ → มี occurrence รอบแรกและ nextFireAt', async () => {
    const out = await createRecurringReminder({
      chatId,
      createdBy: USER,
      title: 'ส่งรายงาน',
      rrule: 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR',
      fireAtMinuteLocal: 480,
      tz: 'Asia/Bangkok',
      now: new Date('2026-09-03T05:00:00.000Z'), // 12:00 ไทย พฤหัส
    });

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.reminder.kind).toBe('recurring');
    // ศุกร์ 4 ก.ย. 08:00 ไทย = 01:00 UTC
    expect(out.firstFireAtUtc.toISOString()).toBe('2026-09-04T01:00:00.000Z');
    expect(out.reminder.nextFireAtUtc?.toISOString()).toBe('2026-09-04T01:00:00.000Z');

    const occ = await occurrencesOf(out.reminder.id);
    expect(occ).toHaveLength(1);
    expect(occ[0]?.canonicalFireAtUtc?.toISOString()).toBe('2026-09-04T01:00:00.000Z');
  });

  it('ยิงแล้วสร้างรอบถัดไปให้อัตโนมัติ และ reminder ยัง active', async () => {
    const out = await createRecurringReminder({
      chatId, createdBy: USER, title: 'x',
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480, tz: 'Asia/Bangkok',
      now: new Date(Date.now() - 2 * 24 * 3_600_000),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;

    const [first] = await occurrencesOf(out.reminder.id);
    await fireOccurrence(first!.id);

    const all = await occurrencesOf(out.reminder.id);
    expect(all).toHaveLength(2);
    expect(all.find((o) => o.id === first!.id)?.status).toBe('sent');
    expect(all.find((o) => o.id !== first!.id)?.status).toBe('pending');

    const reminder = await prisma.reminder.findUnique({ where: { id: out.reminder.id } });
    expect(reminder?.status).toBe('active');
    expect(reminder?.nextFireAtUtc).not.toBeNull();
  });

  it('รอบถัดไปอ้างจาก canonical ไม่ใช่เวลาที่ถูกเลื่อน (ตารางไม่เพี้ยนสะสม)', async () => {
    // เตือนทุกวัน 23:00 ช่วงเงียบ 22:00-07:00 → ยิง 07:00 วันถัดไป
    const out = await createRecurringReminder({
      chatId, createdBy: USER, title: 'x',
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 1380, tz: 'Asia/Bangkok',
      quietHoursStart: 1320, quietHoursEnd: 420,
      now: new Date('2026-09-03T05:00:00.000Z'),
    });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.shiftedByQuietHours).toBe(true);

    const [first] = await occurrencesOf(out.reminder.id);
    // ยิงจริงตอน 07:00 ไทยวันที่ 4
    expect(first!.fireAtUtc.toISOString()).toBe('2026-09-04T00:00:00.000Z');
    // แต่ canonical เป็น 23:00 ไทยวันที่ 3
    expect(first!.canonicalFireAtUtc?.toISOString()).toBe('2026-09-03T16:00:00.000Z');

    await prisma.user.update({
      where: { lineUserId: USER },
      data: { quietHoursStart: 1320, quietHoursEnd: 420 },
    });
    await fireOccurrence(first!.id);

    const all = await occurrencesOf(out.reminder.id);
    const next = all.find((o) => o.id !== first!.id);
    // รอบถัดไปต้องเป็น 07:00 ไทยวันที่ 5 (canonical 23:00 วันที่ 4)
    expect(next?.fireAtUtc.toISOString()).toBe('2026-09-05T00:00:00.000Z');
    expect(next?.canonicalFireAtUtc?.toISOString()).toBe('2026-09-04T16:00:00.000Z');
  });

  it('ยิงซ้ำ occurrence เดิมของการเตือนซ้ำ → ไม่สร้างรอบถัดไปเพิ่ม', async () => {
    const out = await createRecurringReminder({
      chatId, createdBy: USER, title: 'x',
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480, tz: 'Asia/Bangkok',
      now: new Date(Date.now() - 2 * 24 * 3_600_000),
    });
    if (!out.ok) return;
    const [first] = await occurrencesOf(out.reminder.id);

    await fireOccurrence(first!.id);
    await fireOccurrence(first!.id);
    await fireOccurrence(first!.id);

    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(await occurrencesOf(out.reminder.id)).toHaveLength(2);
  });

  it('rrule ที่ใช้ไม่ได้ → ไม่บันทึกอะไรเลย', async () => {
    const out = await createRecurringReminder({
      chatId, createdBy: USER, title: 'x',
      rrule: 'ไม่ใช่ rrule', fireAtMinuteLocal: 480, tz: 'Asia/Bangkok',
    });
    expect(out.ok).toBe(false);
    expect(await prisma.reminder.count({ where: { chatId } })).toBe(0);
  });

  it('กด "เสร็จแล้ว" กับการเตือนซ้ำ → ข้ามแค่รอบนี้ ไม่ปิดทั้งชุด', async () => {
    const out = await createRecurringReminder({
      chatId, createdBy: USER, title: 'x',
      rrule: 'FREQ=DAILY', fireAtMinuteLocal: 480, tz: 'Asia/Bangkok',
      now: new Date(Date.now() - 2 * 24 * 3_600_000),
    });
    if (!out.ok) return;
    const [first] = await occurrencesOf(out.reminder.id);
    await fireOccurrence(first!.id);

    const done = await markOccurrenceDone(first!.id, chatId);
    expect(done?.wasRecurring).toBe(true);

    const reminder = await prisma.reminder.findUnique({ where: { id: out.reminder.id } });
    expect(reminder?.status).toBe('active');
  });

  it('กด "เสร็จแล้ว" กับการเตือนครั้งเดียว → ปิดเลย', async () => {
    const r = await createOnceReminder({
      chatId, createdBy: USER, title: 'x', dueAtUtc: new Date(Date.now() - 60_000),
    });
    const [occ] = await occurrencesOf(r.id);
    const done = await markOccurrenceDone(occ!.id, chatId);
    expect(done?.wasRecurring).toBe(false);
    expect(done?.reminder.status).toBe('done');
  });
});

d('scheduler — เลื่อน (snooze)', () => {
  beforeEach(async () => {
    await resetDb();
    ({ chatId } = await seedChatAndUser({ lineChatId: CHAT, lineUserId: USER }));
    pushMock.mockClear();
    pushMock.mockResolvedValue({ sent: true });
  });

  it('เลื่อน 10 นาที → สร้าง occurrence ใหม่ที่ชี้กลับตัวเดิม แถวเดิมยังเป็น sent', async () => {
    const now = new Date('2026-09-03T05:00:00.000Z');
    const r = await createOnceReminder({
      chatId, createdBy: USER, title: 'กินยา', dueAtUtc: new Date(Date.now() - 60_000),
    });
    const [occ] = await occurrencesOf(r.id);
    await fireOccurrence(occ!.id);

    const out = await snoozeOccurrence(occ!.id, chatId, 10, now);
    expect(out).not.toBeNull();
    expect(out!.occurrence.fireAtUtc.toISOString()).toBe('2026-09-03T05:10:00.000Z');
    expect(out!.occurrence.snoozedFromId).toBe(occ!.id);
    expect(out!.occurrence.status).toBe('pending');

    const old = await prisma.reminderOccurrence.findUnique({ where: { id: occ!.id } });
    expect(old?.status).toBe('sent');
  });

  it('เลื่อนการเตือนที่ปิดไปแล้ว → กลับมา active', async () => {
    const r = await createOnceReminder({
      chatId, createdBy: USER, title: 'x', dueAtUtc: new Date(Date.now() - 60_000),
    });
    const [occ] = await occurrencesOf(r.id);
    await fireOccurrence(occ!.id); // once → done

    await snoozeOccurrence(occ!.id, chatId, 60);
    const reminder = await prisma.reminder.findUnique({ where: { id: r.id } });
    expect(reminder?.status).toBe('active');
  });

  it('เลื่อน occurrence ของแชทอื่นต้องไม่สำเร็จ', async () => {
    const r = await createOnceReminder({
      chatId, createdBy: USER, title: 'x', dueAtUtc: new Date(Date.now() - 60_000),
    });
    const [occ] = await occurrencesOf(r.id);
    const other = await prisma.chat.create({
      data: { lineId: 'Cattack-0000000000000000000003', type: 'group' },
    });
    expect(await snoozeOccurrence(occ!.id, other.id, 10)).toBeNull();
  });

  it('occurrence ที่เลื่อนแล้วยิงได้จริง', async () => {
    const r = await createOnceReminder({
      chatId, createdBy: USER, title: 'x', dueAtUtc: new Date(Date.now() - 60_000),
    });
    const [occ] = await occurrencesOf(r.id);
    await fireOccurrence(occ!.id);
    pushMock.mockClear();

    const snoozed = await snoozeOccurrence(occ!.id, chatId, 10, new Date(Date.now() - 60_000));
    await fireOccurrence(snoozed!.occurrence.id);
    expect(pushMock).toHaveBeenCalledTimes(1);
  });
});

d('scheduler — @mention ตอนยิงเตือนในกลุ่ม (P5)', () => {
  const GROUP = 'Ctest-sched-mention-000000000001';
  let groupChatId = '';

  beforeEach(async () => {
    await resetDb();
    ({ chatId: groupChatId } = await seedChatAndUser({ lineChatId: GROUP, lineUserId: USER, type: 'group' }));
    pushMock.mockClear();
    pushMock.mockResolvedValue({ sent: true });
  });

  it('มี mentionUserIds ที่ยังอยู่ในกลุ่ม → push ข้อความ mention (textV2) คู่กับ Flex', async () => {
    await prisma.groupMember.create({
      data: { chatId: groupChatId, lineUserId: USER, displayName: 'ผู้ทดสอบ' },
    });

    const r = await createOnceReminder({
      chatId: groupChatId,
      createdBy: USER,
      title: 'ส่งรายงาน',
      dueAtUtc: new Date(Date.now() - 60_000),
      mentionUserIds: [USER],
    });
    const [occ] = await occurrencesOf(r.id);
    await fireOccurrence(occ!.id);

    expect(pushMock).toHaveBeenCalledTimes(1);
    const messages = pushMock.mock.calls[0]?.[1] as any[];
    expect(messages).toHaveLength(2);
    expect(messages[0].type).toBe('textV2');
    expect(messages[0].substitution.m0.mentionee.userId).toBe(USER);
    expect(messages[1].type).toBe('flex');
  });

  it('mentionUserIds ที่ยังไม่เคยพูดในกลุ่มเลย (ไม่มีใน group_members) → ยิงแค่ Flex ไม่มี mention', async () => {
    const r = await createOnceReminder({
      chatId: groupChatId,
      createdBy: USER,
      title: 'x',
      dueAtUtc: new Date(Date.now() - 60_000),
      mentionUserIds: ['Uunknown000000000000000000000001'],
    });
    const [occ] = await occurrencesOf(r.id);
    await fireOccurrence(occ!.id);

    const messages = pushMock.mock.calls[0]?.[1] as any[];
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('flex');
  });

  it('push พร้อม mention พลาด (target ใช้ไม่ได้แล้ว) → ลองใหม่แบบไม่มี mention แล้วสำเร็จ', async () => {
    await prisma.groupMember.create({
      data: { chatId: groupChatId, lineUserId: USER, displayName: 'ผู้ทดสอบ' },
    });
    pushMock
      .mockResolvedValueOnce({ sent: false, reason: 'api_error' })
      .mockResolvedValueOnce({ sent: true });

    const r = await createOnceReminder({
      chatId: groupChatId,
      createdBy: USER,
      title: 'x',
      dueAtUtc: new Date(Date.now() - 60_000),
      mentionUserIds: [USER],
    });
    const [occ] = await occurrencesOf(r.id);
    const out = await fireOccurrence(occ!.id);

    expect(out.ok).toBe(true);
    expect(pushMock).toHaveBeenCalledTimes(2);
    const fallback = pushMock.mock.calls[1]?.[1] as any[];
    expect(fallback).toHaveLength(1);
    expect(fallback[0].type).toBe('flex');

    const after = await prisma.reminderOccurrence.findUnique({ where: { id: occ!.id } });
    expect(after?.status).toBe('sent');
  });

  it('ไม่มี mentionUserIds เลย → ยิงแค่ Flex ตามปกติ (พฤติกรรมเดิมจาก P3 ไม่เปลี่ยน)', async () => {
    const r = await createOnceReminder({
      chatId: groupChatId, createdBy: USER, title: 'x', dueAtUtc: new Date(Date.now() - 60_000),
    });
    const [occ] = await occurrencesOf(r.id);
    await fireOccurrence(occ!.id);

    const messages = pushMock.mock.calls[0]?.[1] as any[];
    expect(messages).toHaveLength(1);
    expect(messages[0].type).toBe('flex');
  });
});
