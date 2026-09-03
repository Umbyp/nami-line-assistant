import { describe, expect, it } from 'vitest';
import { buildRichMenuRequest, RICHMENU_NAME, RICHMENU_SIZE } from '../src/richmenu/build.js';
import { decodePostback } from '../src/line/postback.js';

describe('buildRichMenuRequest', () => {
  const req = buildRichMenuRequest();

  it('ขนาดตรงกับที่ประกาศไว้ (ต้องตรงกับ assets/richmenu/menu.html เป๊ะ)', () => {
    expect(req.size).toEqual(RICHMENU_SIZE);
  });

  it('มีชื่อคงที่ ใช้หา/ลบของเก่าตอน setup ซ้ำได้ (idempotent)', () => {
    expect(req.name).toBe(RICHMENU_NAME);
  });

  it('มี 4 ปุ่มตามสเปก', () => {
    expect(req.areas).toHaveLength(4);
  });

  it('ปุ่มครอบคลุมพื้นที่เต็มแผ่นพอดี ไม่มีช่องว่างและไม่ทับกัน', () => {
    const areas = req.areas ?? [];
    let totalArea = 0;
    for (const a of areas) {
      const b = a.bounds!;
      expect(b.x! >= 0 && b.x! < RICHMENU_SIZE.width).toBe(true);
      expect(b.y! >= 0 && b.y! < RICHMENU_SIZE.height).toBe(true);
      expect(b.x! + b.width! <= RICHMENU_SIZE.width).toBe(true);
      expect(b.y! + b.height! <= RICHMENU_SIZE.height).toBe(true);
      totalArea += b.width! * b.height!;
    }
    expect(totalArea).toBe(RICHMENU_SIZE.width * RICHMENU_SIZE.height);

    // ไม่ทับกัน: เช็คว่าไม่มีคู่ไหนที่กรอบซ้อนกัน
    for (let i = 0; i < areas.length; i++) {
      for (let j = i + 1; j < areas.length; j++) {
        const a = areas[i]!.bounds!;
        const b = areas[j]!.bounds!;
        const overlapX = a.x! < b.x! + b.width! && b.x! < a.x! + a.width!;
        const overlapY = a.y! < b.y! + b.height! && b.y! < a.y! + a.height!;
        expect(overlapX && overlapY).toBe(false);
      }
    }
  });

  it('ทุกปุ่มเป็น postback ที่ decode กลับได้ (validate ด้วย zod schema เดียวกับปุ่มอื่น)', () => {
    const areas = req.areas ?? [];
    for (const a of areas) {
      expect(a.action?.type).toBe('postback');
      const out = decodePostback((a.action as { data?: string }).data);
      expect(out.ok).toBe(true);
    }
  });

  it('ปุ่มครบทั้ง 4 action ตามสเปก: แจ้งเตือน/โน้ต-ไฟล์/ตั้งค่า/ช่วยเหลือ', () => {
    const actions = (req.areas ?? [])
      .map((a) => decodePostback((a.action as { data?: string }).data))
      .map((r) => (r.ok ? r.action.a : `decode_failed`));
    expect(actions.sort()).toEqual(['help', 'rm.list', 'settings.view', 'vault.list'].sort());
  });

  it('เรียกซ้ำได้ผลเหมือนเดิมทุกครั้ง (deterministic, ไม่มี state สุ่ม)', () => {
    expect(buildRichMenuRequest()).toEqual(buildRichMenuRequest());
  });
});
