import { describe, expect, it } from 'vitest';
import type { webhook } from '@line/bot-sdk';
import { gateGroupMessage } from '../src/handlers/groupGate.js';

function textMsg(
  text: string,
  mention?: webhook.Mention,
): webhook.TextMessageContent {
  return { type: 'text', id: '1', text, quoteToken: 'qt', ...(mention ? { mention } : {}) };
}

describe('gateGroupMessage — แชท 1:1', () => {
  it('ตอบทุกข้อความ', () => {
    const r = gateGroupMessage(textMsg('เตือนกินยา 18.00'), false);
    expect(r.shouldRespond).toBe(true);
    expect(r.via).toBe('direct');
    expect(r.cleanedText).toBe('เตือนกินยา 18.00');
  });
});

describe('gateGroupMessage — ในกลุ่ม', () => {
  it('ไม่ตอบข้อความคุยกันปกติ (กันสแปม)', () => {
    const r = gateGroupMessage(textMsg('กินข้าวกันยังพวกเรา'), true);
    expect(r.shouldRespond).toBe(false);
    expect(r.via).toBe('none');
  });

  it('ตอบเมื่อขึ้นต้นด้วย "นามิ" และตัดคำเรียกออก', () => {
    const r = gateGroupMessage(textMsg('นามิ เตือนส่งรายงานทุกศุกร์ 5 โมงเย็น'), true);
    expect(r.shouldRespond).toBe(true);
    expect(r.via).toBe('wake-word');
    expect(r.cleanedText).toBe('เตือนส่งรายงานทุกศุกร์ 5 โมงเย็น');
  });

  it('รับคำเรียกที่มีเครื่องหมายวรรคตอนตามหลัง', () => {
    expect(gateGroupMessage(textMsg('นามิ, ช่วยด้วย'), true).cleanedText).toBe('ช่วยด้วย');
    expect(gateGroupMessage(textMsg('นามิ: ช่วยด้วย'), true).cleanedText).toBe('ช่วยด้วย');
    expect(gateGroupMessage(textMsg('  นามิช่วยด้วย'), true).cleanedText).toBe('ช่วยด้วย');
  });

  it('รับคำเรียก nami แบบอังกฤษ ไม่สนตัวพิมพ์เล็กใหญ่', () => {
    const r = gateGroupMessage(textMsg('Nami remind me at 6pm'), true);
    expect(r.shouldRespond).toBe(true);
    expect(r.cleanedText).toBe('remind me at 6pm');
  });

  it('ไม่ตอบถ้า "นามิ" อยู่กลางประโยค (พูดถึง ไม่ได้เรียก)', () => {
    const r = gateGroupMessage(textMsg('เมื่อวานถามนามิแล้วนะ'), true);
    expect(r.shouldRespond).toBe(false);
  });

  it('ตอบเมื่อถูก @mention ตัวบอท และตัดข้อความ mention ออก', () => {
    // "@นามิ เตือนประชุม" — mention กินอักขระตำแหน่ง 0-5
    const r = gateGroupMessage(
      textMsg('@นามิ เตือนประชุม', {
        mentionees: [{ index: 0, length: 5, type: 'user', userId: 'Ubot', isSelf: true }],
      }),
      true,
    );
    expect(r.shouldRespond).toBe(true);
    expect(r.via).toBe('mention');
    expect(r.cleanedText).toBe('เตือนประชุม');
  });

  it('ไม่ตอบเมื่อ mention คนอื่น ไม่ได้ mention บอท', () => {
    const r = gateGroupMessage(
      textMsg('@โบ๊ท ส่งไฟล์ด้วย', {
        mentionees: [{ index: 0, length: 5, type: 'user', userId: 'Uboat', isSelf: false }],
      }),
      true,
    );
    expect(r.shouldRespond).toBe(false);
  });

  it('mention บอทหลายตำแหน่ง ตัดออกครบและ index ไม่เพี้ยน', () => {
    // "@นามิ ช่วย @นามิ ด้วย"  → index 0 (len 5) และ index 11 (len 5)
    const text = '@นามิ ช่วย @นามิ ด้วย';
    const r = gateGroupMessage(
      textMsg(text, {
        mentionees: [
          { index: 0, length: 5, type: 'user', userId: 'Ubot', isSelf: true },
          { index: 11, length: 5, type: 'user', userId: 'Ubot', isSelf: true },
        ],
      }),
      true,
    );
    expect(r.shouldRespond).toBe(true);
    expect(r.cleanedText).toBe('ช่วย  ด้วย');
  });

  it('mention บอทพร้อมคนอื่น — ตอบ และตัดแค่ mention ของบอท', () => {
    const r = gateGroupMessage(
      textMsg('@นามิ เตือน @โบ๊ท ประชุม', {
        mentionees: [
          { index: 0, length: 5, type: 'user', userId: 'Ubot', isSelf: true },
          { index: 13, length: 5, type: 'user', userId: 'Uboat', isSelf: false },
        ],
      }),
      true,
    );
    expect(r.shouldRespond).toBe(true);
    expect(r.cleanedText).toContain('@โบ๊ท');
  });
});
