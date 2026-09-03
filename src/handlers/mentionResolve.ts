import { prisma } from '../lib/prisma.js';

export interface ResolvedAssignee {
  /** ชื่อที่ผู้ใช้พิมพ์มา (ก่อนจับคู่) */
  requestedName: string;
  userId: string;
  displayName: string;
}

export interface AssigneeResolution {
  resolved: ResolvedAssignee[];
  /** ชื่อที่จับคู่ไม่ได้ — ต้องบอกผู้ใช้ให้คนนั้นพิมพ์ในกลุ่มก่อน */
  unresolved: string[];
}

/**
 * จับคู่ชื่อที่ NLU ดึงมาได้ (เช่น "พี่โบ๊ท") กับสมาชิกกลุ่มที่นามิรู้จักแล้ว
 *
 * ทำไมต้องมีขั้นนี้: LINE ไม่ให้ list สมาชิกกลุ่ม (ถ้าไม่ใช่ verified OA)
 * เราจึงรู้จักได้แค่คนที่เคยพูดในกลุ่มมาก่อน (เก็บไว้ใน group_members ตั้งแต่ P1)
 * ถ้าคนที่ถูกมอบหมายยังไม่เคยพูดในกลุ่มเลย จะไม่มีทางรู้ userId ของเขาได้
 *
 * กติกาจับคู่ (อนุรักษ์นิยม — พลาดแล้วเงียบไว้ดีกว่าเดา mention ผิดคน):
 *   1. ตรงเป๊ะ (ตัดช่องว่าง/ตัวพิมพ์เล็กใหญ่) ชนะทันที
 *   2. ไม่เจอ → ลองจับแบบ substring ทั้งสองทิศทาง ("โบ๊ท" ⊂ "พี่โบ๊ท เก่งกาจ")
 *      ถ้าเจอมากกว่า 1 คนที่คะแนนเท่ากัน → ไม่ resolve (กันเลือกผิดคน)
 */
export async function resolveAssignees(
  chatId: string,
  names: string[],
): Promise<AssigneeResolution> {
  const resolved: ResolvedAssignee[] = [];
  const unresolved: string[] = [];
  if (names.length === 0) return { resolved, unresolved };

  const members = await prisma.groupMember.findMany({
    where: { chatId, displayName: { not: null } },
    select: { lineUserId: true, displayName: true },
  });

  for (const requestedName of names) {
    const needle = normalize(requestedName);
    if (needle === '') {
      unresolved.push(requestedName);
      continue;
    }

    const exact = members.filter((m) => normalize(m.displayName ?? '') === needle);
    if (exact.length === 1 && exact[0]) {
      resolved.push({ requestedName, userId: exact[0].lineUserId, displayName: exact[0].displayName! });
      continue;
    }
    if (exact.length > 1) {
      // ชื่อซ้ำกันในกลุ่ม (เช่นสองคนตั้งชื่อ LINE เหมือนกัน) — เดาไม่ได้ว่าใคร
      unresolved.push(requestedName);
      continue;
    }

    const partial = members.filter((m) => {
      const hay = normalize(m.displayName ?? '');
      return hay !== '' && (hay.includes(needle) || needle.includes(hay));
    });

    if (partial.length === 1 && partial[0]) {
      resolved.push({ requestedName, userId: partial[0].lineUserId, displayName: partial[0].displayName! });
    } else {
      unresolved.push(requestedName);
    }
  }

  return { resolved, unresolved };
}

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, '');
}
