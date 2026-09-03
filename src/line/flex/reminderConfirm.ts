import type { messagingApi } from '@line/bot-sdk';
import { DateTime } from 'luxon';
import { T, SIZE } from './theme.js';
import { encodePostback } from '../postback.js';
import { formatThaiFriendly, formatThaiDateTime, inZone } from '../../lib/time.js';
import { env } from '../../config/env.js';

export interface ReminderConfirmInput {
  reminderId: string;
  title: string;
  note?: string | null;
  dueAtUtc: Date;
  /** ระบุว่าถูกเลื่อนไปวันถัดไปให้อัตโนมัติ เพื่อบอกผู้ใช้ตรงๆ ว่าเราตีความยังไง */
  shiftedDays?: number;
  /** ชื่อคนที่ถูกมอบหมาย (ในกลุ่ม) */
  assigneeLabels?: string[];
  /** ชื่อคนที่ยังไม่รู้ userId — ต้องบอกผู้ใช้ให้คนนั้นพิมพ์ในกลุ่มก่อน */
  unknownAssignees?: string[];
  /** คำอธิบายการเตือนซ้ำ เช่น "ทุกวันจันทร์-ศุกร์ 08:00" — ใส่เมื่อเป็น recurring */
  recurrenceLabel?: string | null;
  /** รอบแรกถูกเลื่อนเพราะตกในช่วงเวลาเงียบ */
  quietHoursShifted?: boolean;
  tz?: string;
  now?: Date;
}

/**
 * Flex ยืนยันการตั้งเตือน — บันทึกไปแล้วตอนที่ส่งอันนี้
 * ปุ่มทั้งสองเป็น postback เพราะ LINE แก้ข้อความที่ส่งไปแล้วไม่ได้
 *
 * [เปลี่ยนเวลา] ใช้ datetimepicker ของ LINE ไม่ให้ผู้ใช้พิมพ์เวลาใหม่
 * เพราะพิมพ์แล้วต้องส่งเข้า NLU อีกรอบ เสียเงินและพลาดได้
 */
export function reminderConfirm(input: ReminderConfirmInput): messagingApi.FlexMessage {
  const tz = input.tz ?? env.APP_TIMEZONE;
  const now = input.now ?? new Date();
  const friendly = formatThaiFriendly(input.dueAtUtc, tz, now);
  const full = formatThaiDateTime(input.dueAtUtc, tz, now);

  const bodyContents: messagingApi.FlexComponent[] = [
    {
      type: 'text',
      text: input.title,
      weight: 'bold',
      size: SIZE.title,
      color: T.ink,
      wrap: true,
    },
  ];

  if (input.note) {
    bodyContents.push({
      type: 'text',
      text: input.note,
      size: SIZE.body,
      color: T.inkSoft,
      wrap: true,
      margin: 'sm',
    });
  }

  const isRecurring = Boolean(input.recurrenceLabel);

  bodyContents.push({
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    spacing: 'sm',
    contents: [
      // การเตือนซ้ำ: บอก "รอบไหน" ก่อน แล้วค่อยบอกว่าซ้ำแบบไหน
      ...(isRecurring ? [row('ซ้ำ', input.recurrenceLabel as string)] : []),
      row(isRecurring ? 'ครั้งแรก' : 'เมื่อ', friendly),
      // แสดงวันเต็มด้วย เพราะ "พรุ่งนี้ 08:30" อ่านง่ายแต่กำกวมถ้าผู้ใช้กลับมาดูทีหลัง
      ...(friendly === full ? [] : [row('วันที่', full)]),
      ...(input.assigneeLabels?.length ? [row('มอบหมาย', input.assigneeLabels.join(', '))] : []),
    ],
  });

  // บอกตรงๆ ว่าเราเลื่อนวันให้ เพราะเวลาที่ขอผ่านไปแล้ว — ไม่เงียบแล้วให้ผู้ใช้เซอร์ไพรส์
  if (input.shiftedDays && input.shiftedDays > 0) {
    bodyContents.push(notice(`เวลาที่บอกผ่านไปแล้ววันนี้ นามิจึงตั้งเป็นวันถัดไปให้`, T.warn));
  }

  // เลื่อนเพราะช่วงเวลาเงียบ — ต้องบอก ไม่งั้นผู้ใช้จะสงสัยว่าทำไมเตือนไม่ตรงเวลาที่สั่ง
  if (input.quietHoursShifted) {
    bodyContents.push(
      notice('เวลาที่ตั้งตกในช่วงเวลาเงียบ นามิจึงเลื่อนไปเตือนตอนออกจากช่วงเงียบให้', T.warn),
    );
  }

  if (input.unknownAssignees?.length) {
    bodyContents.push(
      notice(
        `นามิยังไม่รู้จัก ${input.unknownAssignees.join(', ')} ` +
          'ให้คนนั้นพิมพ์ในกลุ่มครั้งนึงก่อนนะ นามิจะจำไว้',
        T.warn,
      ),
    );
  }

  return {
    type: 'flex',
    altText: input.recurrenceLabel
      ? `ตั้งเตือนแล้ว: ${input.title} — ${input.recurrenceLabel}`
      : `ตั้งเตือนแล้ว: ${input.title} — ${friendly}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'horizontal',
        backgroundColor: T.brand,
        paddingAll: 'md',
        contents: [
          {
            type: 'text',
            text: 'ตั้งเตือนให้แล้ว',
            color: T.white,
            weight: 'bold',
            size: SIZE.body,
          },
        ],
      },
      body: {
        type: 'box',
        layout: 'vertical',
        paddingAll: 'lg',
        contents: bodyContents,
      },
      footer: {
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          // การเตือนซ้ำใช้ datetimepicker ไม่ได้ — การแก้ "เวลาของทุกวัน"
          // ไม่ใช่การเลือกวันเวลาครั้งเดียว จึงให้ดูรายการแล้วจัดการที่นั่น
          isRecurring
            ? {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: {
                  type: 'postback',
                  label: 'ดูรายการ',
                  data: encodePostback({ a: 'rm.list' }),
                  displayText: 'ดูการเตือนทั้งหมด',
                },
              }
            : {
                type: 'button',
                style: 'secondary',
                height: 'sm',
                action: {
                  type: 'datetimepicker',
                  label: 'เปลี่ยนเวลา',
                  data: encodePostback({ a: 'rm.retime', id: input.reminderId }),
                  mode: 'datetime',
                  // ค่าเริ่มต้นคือเวลาเดิม เพื่อให้ผู้ใช้ปรับจากจุดนั้น
                  initial: pickerFormat(input.dueAtUtc, tz),
                  // ห้ามเลือกเวลาที่ผ่านมาแล้ว
                  min: pickerFormat(now, tz),
                  max: pickerFormat(DateTime.fromJSDate(now).plus({ years: 3 }).toJSDate(), tz),
                },
              },
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            color: T.brandSoft,
            action: {
              type: 'postback',
              label: 'ยกเลิก',
              data: encodePostback({ a: 'rm.cancel', id: input.reminderId }),
              displayText: 'ยกเลิกการเตือนนี้',
            },
          },
        ],
      },
    },
  };
}

function row(label: string, value: string): messagingApi.FlexComponent {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'sm',
    contents: [
      { type: 'text', text: label, size: SIZE.label, color: T.inkFaint, flex: 2 },
      { type: 'text', text: value, size: SIZE.body, color: T.ink, flex: 5, wrap: true },
    ],
  };
}

function notice(text: string, color: string): messagingApi.FlexComponent {
  return {
    type: 'box',
    layout: 'vertical',
    margin: 'lg',
    paddingAll: 'sm',
    cornerRadius: 'md',
    backgroundColor: T.brandSoft,
    contents: [{ type: 'text', text, size: SIZE.label, color, wrap: true }],
  };
}

/** datetimepicker ต้องการรูปแบบ 'YYYY-MM-DDThh:mm' เป็นเวลาท้องถิ่น */
export function pickerFormat(d: Date, tz: string = env.APP_TIMEZONE): string {
  return inZone(d, tz).toFormat("yyyy-MM-dd'T'HH:mm");
}
