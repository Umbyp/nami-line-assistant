import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma.js';
import { dbReady, resetDb, seedChatAndUser } from './helpers/db.js';
import { resolveAssignees } from '../src/handlers/mentionResolve.js';

const d = dbReady ? describe : describe.skip;

const CHAT = 'Ctest-mention-000000000000000001';
const USER = 'Utest-mentionuser-000000000000001';
let chatId = '';

async function addMember(userId: string, displayName: string): Promise<void> {
  await prisma.user.upsert({
    where: { lineUserId: userId },
    create: { lineUserId: userId, displayName },
    update: {},
  });
  await prisma.groupMember.create({ data: { chatId, lineUserId: userId, displayName } });
}

d('resolveAssignees', () => {
  beforeEach(async () => {
    await resetDb();
    ({ chatId } = await seedChatAndUser({ lineChatId: CHAT, lineUserId: USER, type: 'group' }));
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('จับคู่ชื่อตรงเป๊ะ', async () => {
    await addMember('Uboat00000000000000000000000001', 'โบ๊ท');
    const out = await resolveAssignees(chatId, ['โบ๊ท']);
    expect(out.resolved).toEqual([
      { requestedName: 'โบ๊ท', userId: 'Uboat00000000000000000000000001', displayName: 'โบ๊ท' },
    ]);
    expect(out.unresolved).toEqual([]);
  });

  it('ตัดช่องว่างและไม่สนตัวพิมพ์เล็กใหญ่ (สำหรับชื่ออังกฤษ)', async () => {
    await addMember('Ualice0000000000000000000000001', 'Alice');
    const out = await resolveAssignees(chatId, ['  alice  ']);
    expect(out.resolved[0]?.userId).toBe('Ualice0000000000000000000000001');
  });

  it('จับคู่แบบ substring: "โบ๊ท" ⊂ "พี่โบ๊ท เก่งกาจ"', async () => {
    await addMember('Uboat00000000000000000000000001', 'พี่โบ๊ท เก่งกาจ');
    const out = await resolveAssignees(chatId, ['โบ๊ท']);
    expect(out.resolved[0]?.userId).toBe('Uboat00000000000000000000000001');
  });

  it('จับคู่แบบ substring ย้อนกลับ: ชื่อที่ขอยาวกว่าชื่อที่รู้จัก', async () => {
    await addMember('Uboat00000000000000000000000001', 'โบ๊ท');
    const out = await resolveAssignees(chatId, ['พี่โบ๊ท']);
    expect(out.resolved[0]?.userId).toBe('Uboat00000000000000000000000001');
  });

  it('ไม่รู้จักเลย → unresolved', async () => {
    const out = await resolveAssignees(chatId, ['คนแปลกหน้า']);
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual(['คนแปลกหน้า']);
  });

  it('ชื่อซ้ำกันในกลุ่ม (สองคนชื่อเหมือนกัน) → ไม่เดา ถือว่า unresolved', async () => {
    await addMember('Ua0000000000000000000000000001', 'นุช');
    await addMember('Ub0000000000000000000000000002', 'นุช');
    const out = await resolveAssignees(chatId, ['นุช']);
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual(['นุช']);
  });

  it('จับคู่ substring ได้มากกว่า 1 คน → ไม่เดา ถือว่า unresolved', async () => {
    await addMember('Ua0000000000000000000000000001', 'พี่บอล');
    await addMember('Ub0000000000000000000000000002', 'น้องบอล');
    const out = await resolveAssignees(chatId, ['บอล']);
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual(['บอล']);
  });

  it('ผสมกันได้: บางคนรู้จัก บางคนไม่รู้จัก', async () => {
    await addMember('Uboat00000000000000000000000001', 'โบ๊ท');
    const out = await resolveAssignees(chatId, ['โบ๊ท', 'คนไม่รู้จัก']);
    expect(out.resolved.map((r) => r.displayName)).toEqual(['โบ๊ท']);
    expect(out.unresolved).toEqual(['คนไม่รู้จัก']);
  });

  it('ไม่เห็นสมาชิกของกลุ่มอื่น', async () => {
    await addMember('Uboat00000000000000000000000001', 'โบ๊ท');
    const other = await prisma.chat.create({ data: { lineId: 'Cother-mention-00000000000001', type: 'group' } });
    const out = await resolveAssignees(other.id, ['โบ๊ท']);
    expect(out.resolved).toEqual([]);
    expect(out.unresolved).toEqual(['โบ๊ท']);
  });

  it('ชื่อว่างเปล่า → unresolved ไม่ throw', async () => {
    const out = await resolveAssignees(chatId, ['   ']);
    expect(out.unresolved).toEqual(['   ']);
  });

  it('ไม่มีชื่อให้ resolve → คืน array ว่างทั้งคู่ ไม่ query DB', async () => {
    const out = await resolveAssignees(chatId, []);
    expect(out).toEqual({ resolved: [], unresolved: [] });
  });
});
