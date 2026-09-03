import { DateTime } from 'luxon';
import { env } from '../config/env.js';
import { extractClockMinute, looksRecurring } from './thaiTime.js';
import { LOCAL_DATE_RE, type ImageReminderItem, type ResolvedDraftItem } from './imageSchema.js';

const WEEKDAY_NUM: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 };

/**
 * จับช่วงเวลาแบบ "07-15" "07:00-15:00" "23-07" (กะข้ามเที่ยงคืน) แล้วคืนจุดเริ่มต้น
 * เฉพาะรูปแบบตัวเลขล้วนคั่นด้วย - เท่านั้น (ไม่ใช้คำว่า "ถึง"/"จนถึง" เพราะนั่นคือข้อความทั่วไป
 * ที่ extractClockMinute ตั้งใจปฏิเสธไปแล้วในกรณีข้อความคุยกัน)
 */
function extractRangeStart(text: string): { minute: number; matched: string } | null {
  const m = /(\d{1,2})(?::(\d{2}))?\s*-\s*(\d{1,2})(?::(\d{2}))?/.exec(text.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2] ?? '0');
  if (h > 23 || min > 59) return null;
  return { minute: h * 60 + min, matched: m[0] };
}

/**
 * แปลง item ที่โมเดลอ่านจากรูปได้ → เวลาจริงที่ใช้สร้างเตือนได้
 *
 * หลักการเดียวกับ resolveFireMinute/resolveDueAt ที่ใช้กับข้อความ (ดู thaiTime.ts, resolveTime.ts):
 * ไม่เชื่อตัวเลขที่โมเดลคำนวณเอง เพราะพลาดซ้ำๆ มาตลอดทั้งโปรเจกต์ (ดู README หัวข้อ NLU)
 * โมเดลจึงถูกสั่งให้ส่ง "ข้อความเวลาที่เห็นในเอกสาร" (timeText) มาแทน แล้วโค้ดนี้คำนวณเองด้วย
 * extractClockMinute — ฟังก์ชันเดียวกับที่ใช้ตรวจทานเวลาจากข้อความผู้ใช้ ผ่านการทดสอบมาหนักแล้ว
 *
 * รายการที่แปลงไม่ได้ (เวลาอ่านไม่ออก, วันที่ไม่สมเหตุผล) จะได้ problem !== null
 * กลับไป ห้ามเดาแล้วสร้างเตือนผิดเวลาให้ผู้ใช้เด็ดขาด
 */
export function resolveImageItem(
  item: ImageReminderItem,
  opts: { now?: Date; tz?: string } = {},
): ResolvedDraftItem {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? env.APP_TIMEZONE;

  // เจอจริงตอนทดสอบกับตารางเวล่า: timeText ที่มาจากตารางเวรมักเป็นช่วง เช่น "07-15" "23-07"
  // (คัดลอกหัวคอลัมน์ "เวรเช้า (07-15)" มาตรงๆ ตามที่สั่งในพรอมต์) extractClockMinute (ใช้ร่วมกับ
  // ข้อความผู้ใช้ทั่วไป) ตั้งใจปฏิเสธช่วงเวลาแบบนี้เพราะข้อความคุยกันทั่วไปตีความสองด้านไม่ได้ว่าจะเอาด้านไหน
  // แต่เอกสารตารางเวร/ตารางเรียนมีความหมายชัดเจนอยู่แล้วว่า "เตือนตอนเริ่มกะ" จึงแยกจัดการที่นี่
  // แทนที่จะไปแก้ extractClockMinute ที่ใช้ร่วมกับข้อความ (จะกระทบกฎ "หลายเวลาขัดกัน → ไม่เดา")
  const clock = extractClockMinute(item.timeText) ?? extractRangeStart(item.timeText);
  if (!clock) {
    return fail(item, `อ่านเวลาจากเอกสารไม่ออก: "${item.timeText}"`);
  }

  if (item.kind === 'once') {
    if (!item.dateLocal || !LOCAL_DATE_RE.test(item.dateLocal)) {
      return fail(item, `ไม่มีวันที่ หรือรูปแบบผิด: "${item.dateLocal}"`);
    }

    const local = DateTime.fromISO(item.dateLocal, { zone: tz }).set({
      hour: Math.floor(clock.minute / 60),
      minute: clock.minute % 60,
      second: 0,
      millisecond: 0,
    });

    if (!local.isValid) {
      return fail(item, `วันที่ไม่มีอยู่จริง: "${item.dateLocal}" (${local.invalidReason})`);
    }

    // ปีไกลเกินไปมักแปลว่าแปลง พ.ศ./ค.ศ. พลาด — เอกสารจริงไม่ควรนัดล่วงหน้าเกิน 2 ปี
    const nowLocal = DateTime.fromJSDate(now, { zone: tz });
    if (Math.abs(local.diff(nowLocal, 'years').years) > 2) {
      return fail(item, `ปีดูผิดปกติ (${item.dateLocal}) น่าจะแปลง พ.ศ./ค.ศ. พลาด`);
    }

    return {
      title: item.title,
      kind: 'once',
      dueAtUtc: local.toUTC().toJSDate(),
      rrule: null,
      fireAtMinuteLocal: null,
      confidence: item.confidence,
      problem: null,
    };
  }

  // recurring
  if (!item.weekday) {
    return fail(item, 'ไม่รู้ว่าเป็นวันไหนของสัปดาห์');
  }
  const dow = WEEKDAY_NUM[item.weekday];
  if (!dow) {
    return fail(item, `ชื่อวันไม่รู้จัก: "${item.weekday}"`);
  }

  return {
    title: item.title,
    kind: 'recurring',
    dueAtUtc: null,
    rrule: `FREQ=WEEKLY;BYDAY=${item.weekday}`,
    fireAtMinuteLocal: clock.minute,
    confidence: item.confidence,
    problem: null,
  };
}

function fail(item: ImageReminderItem, problem: string): ResolvedDraftItem {
  return {
    title: item.title,
    kind: item.kind,
    dueAtUtc: null,
    rrule: null,
    fireAtMinuteLocal: null,
    confidence: 0,
    problem,
  };
}

/**
 * เอกสารบางแบบ (ตารางเวร/ตารางเรียน) มักมีคำว่า "ประจำ"/"ทุกสัปดาห์" ในชื่อเอกสารแม้ตัวรายการ
 * แต่ละแถวจะผูกกับวันเดียว (เช่น "จ. เวรเช้า") — โมเดลอาจสับสนว่า item นั้น kind อะไร
 * ใช้กฎเดียวกับ looksRecurring ของข้อความ ถ้า title มีคำว่า "ทุก" ให้เชื่อว่า recurring แน่นอน
 * ฟังก์ชันนี้ไม่ได้ใช้บังคับ (โมเดล field kind ค่อนข้างแม่นจากเทสต์จริง) แต่ export ไว้เผื่อ debug
 */
export function titleLooksRecurring(title: string): boolean {
  return looksRecurring(title);
}
