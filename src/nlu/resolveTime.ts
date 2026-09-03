import { DateTime } from 'luxon';
import { env } from '../config/env.js';
import { LOCAL_DATETIME_LOOSE_RE } from './schema.js';

export type ResolveDueFailure =
  /** โมเดลไม่ได้ส่งเวลามาเลย */
  | 'missing'
  /** รูปแบบไม่ใช่ YYYY-MM-DDTHH:mm หรือเป็นวันที่ที่ไม่มีจริง (31 ก.ย., 29 ก.พ. ปีไม่อธิกสุรทิน) */
  | 'bad_format'
  /** ผู้ใช้ระบุวันชัดเจนแต่วันนั้นผ่านไปแล้ว — ต้องถามกลับ ไม่ใช่เลื่อนให้เอง */
  | 'past_explicit_date'
  /** ไกลเกินเหตุ (เกิน 5 ปี) มักเกิดจากโมเดลแปลง พ.ศ./ค.ศ. พลาด */
  | 'too_far';

export type ResolveDueOutcome =
  | {
      ok: true;
      dueAtUtc: Date;
      /** เลื่อนไปกี่วันเพราะเวลาที่ขอผ่านไปแล้ว (0 = ไม่ได้เลื่อน) */
      shiftedDays: number;
    }
  | { ok: false; reason: ResolveDueFailure; detail: string };

/** เผื่อเวลาที่ผ่านไปเล็กน้อยระหว่าง webhook → worker (job อาจค้างคิวสักครู่) */
const GRACE_MS = 60_000;
const MAX_YEARS_AHEAD = 5;

/**
 * แปลง "เวลาไทยเป็นสตริง" จากโมเดล → Date (UTC) ที่เอาไปเก็บ DB ได้
 *
 * ส่วนนี้เป็น deterministic ทั้งหมด ไม่เรียก LLM
 * เจตนา: เอาการตัดสินใจเรื่อง "เวลาผ่านไปแล้วจะทำยังไง" ออกจากมือโมเดล
 * เพราะโมเดลทำไม่สม่ำเสมอ แต่กฎข้อนี้ต้องเหมือนกันทุกครั้ง
 *
 *   ไม่ได้ระบุวัน + เวลาผ่านไปแล้ว → เลื่อนเป็นวันถัดไป (ผู้ใช้หมายถึงพรุ่งนี้)
 *   ระบุวันชัดเจน + ผ่านไปแล้ว     → ถามกลับ (อาจพิมพ์ปีผิด หรืออยากปีหน้า)
 */
export function resolveDueAt(
  dueAtLocal: string | null,
  dateWasExplicit: boolean,
  opts: { now?: Date; tz?: string } = {},
): ResolveDueOutcome {
  const now = opts.now ?? new Date();
  const tz = opts.tz ?? env.APP_TIMEZONE;

  if (!dueAtLocal) {
    return { ok: false, reason: 'missing', detail: 'โมเดลไม่ได้ส่ง dueAtLocal มา' };
  }
  if (!LOCAL_DATETIME_LOOSE_RE.test(dueAtLocal)) {
    return {
      ok: false,
      reason: 'bad_format',
      detail: `ต้องเป็น YYYY-MM-DDTHH:mm แต่ได้ "${dueAtLocal}"`,
    };
  }

  // สตริงไม่มี offset — ตีความเป็นเวลาท้องถิ่นของ tz
  // ตัดวินาที/มิลลิวินาทีทิ้ง เพราะเราตั้งเตือนละเอียดถึงระดับนาที
  let local = DateTime.fromISO(dueAtLocal, { zone: tz }).startOf('minute');
  if (!local.isValid) {
    return {
      ok: false,
      reason: 'bad_format',
      detail: `วันที่ไม่มีอยู่จริง: "${dueAtLocal}" (${local.invalidReason})`,
    };
  }

  const nowLocal = DateTime.fromJSDate(now, { zone: tz });

  if (local.diff(nowLocal).toMillis() > MAX_YEARS_AHEAD * 365 * 24 * 3_600_000) {
    return {
      ok: false,
      reason: 'too_far',
      detail: `${dueAtLocal} ไกลเกิน ${MAX_YEARS_AHEAD} ปี น่าจะแปลงปี พ.ศ./ค.ศ. พลาด`,
    };
  }

  // เก่ากว่าเส้นนี้ = ถือว่าผ่านไปแล้ว (เผื่อ grace ให้ job ที่ค้างคิวสักครู่)
  const staleBefore = nowLocal.toMillis() - GRACE_MS;
  let shiftedDays = 0;

  while (local.toMillis() <= staleBefore) {
    if (dateWasExplicit) {
      return {
        ok: false,
        reason: 'past_explicit_date',
        detail: `${dueAtLocal} ผ่านไปแล้ว`,
      };
    }

    local = local.plus({ days: 1 });
    shiftedDays++;

    // กันวนไม่จบถ้าคำนวณอะไรพลาด — ในทางปฏิบัติวนรอบเดียวก็พ้นแล้ว
    if (shiftedDays > 366) {
      return { ok: false, reason: 'bad_format', detail: 'เลื่อนวันไม่จบ' };
    }
  }

  return { ok: true, dueAtUtc: local.toUTC().toJSDate(), shiftedDays };
}
