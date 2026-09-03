import type { webhook } from '@line/bot-sdk';

/** คำเรียกนามิที่ยอมรับตอนขึ้นต้นข้อความในกลุ่ม */
const WAKE_WORDS = ['นามิ', 'นามี่', 'nami'];

export interface GroupGateResult {
  /** นามิควรตอบ event นี้ไหม */
  shouldRespond: boolean;
  /** ข้อความที่ตัดคำเรียก/mention ออกแล้ว พร้อมส่งเข้า NLU */
  cleanedText: string;
  /** ถูกเรียกด้วยวิธีไหน (ใช้ log/debug) */
  via: 'mention' | 'wake-word' | 'direct' | 'none';
}

/**
 * ในกลุ่ม นามิจะตอบเฉพาะเมื่อถูก @mention หรือข้อความขึ้นต้นด้วย "นามิ"
 * เพื่อไม่ให้กลายเป็นบอทสแปมที่ตอบทุกข้อความในกลุ่ม
 *
 * ในแชท 1:1 ตอบทุกข้อความ (via = 'direct')
 */
export function gateGroupMessage(
  message: webhook.TextMessageContent,
  isGroup: boolean,
): GroupGateResult {
  const raw = message.text ?? '';

  if (!isGroup) {
    return { shouldRespond: true, cleanedText: raw.trim(), via: 'direct' };
  }

  // ── ถูก @mention ตัวบอทเอง ──
  // isSelf = true คือ mentionee ที่เป็นบอทเรา (LINE ใส่ให้เอง)
  // mentionee ชนิด 'all' (@all) ไม่มี isSelf → ไม่นับว่าเรียกนามิ
  const selfMentions = (message.mention?.mentionees ?? []).filter(
    (m): m is webhook.UserMentionee => m.type === 'user' && m.isSelf === true,
  );

  if (selfMentions.length > 0) {
    // ตัดช่วงข้อความที่เป็น mention ของบอทออก โดยไล่จากท้ายมาหน้า
    // เพื่อให้ index ของ mention ตัวก่อนหน้าไม่เพี้ยน
    let text = raw;
    const sorted = [...selfMentions].sort((a, b) => b.index - a.index);
    for (const m of sorted) {
      text = text.slice(0, m.index) + text.slice(m.index + m.length);
    }
    return { shouldRespond: true, cleanedText: text.trim(), via: 'mention' };
  }

  // ── ขึ้นต้นด้วยคำเรียก ──
  const trimmed = raw.trimStart();
  const lower = trimmed.toLowerCase();
  for (const w of WAKE_WORDS) {
    if (lower.startsWith(w)) {
      // ตัดคำเรียกออก แล้วเก็บช่องว่าง/เครื่องหมายวรรคตอนที่ตามมาทิ้งด้วย
      const stripped = trimmed.slice(w.length).replace(/^[\s,:!?ๆ.\-]+/u, '');
      return { shouldRespond: true, cleanedText: stripped.trim(), via: 'wake-word' };
    }
  }

  return { shouldRespond: false, cleanedText: '', via: 'none' };
}
