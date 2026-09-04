import type { messagingApi } from '@line/bot-sdk';
import type { Reminder } from '@prisma/client';
import { T, SIZE } from './theme.js';
import { encodePostback } from '../postback.js';
import { formatThaiFriendly } from '../../lib/time.js';
import { describeRecurrence } from '../../scheduler/nextOccurrence.js';
import { pickerFormat } from './reminderConfirm.js';
import { env } from '../../config/env.js';

/** LINE จำกัด carousel ไว้ 12 bubble */
export const LIST_MAX = 10;

export interface ReminderListInput {
  reminders: Reminder[];
  tz?: string;
  now?: Date;
  /** จำนวนทั้งหมด (อาจมากกว่าที่แสดง) */
  total?: number;
}

/**
 * รายการเตือนพร้อมปุ่มแก้/ลบรายตัว
 *
 * ใช้ carousel ไม่ใช่ bubble เดียวที่มีหลายบรรทัด
 * เพราะปุ่มต้องผูกกับ reminder แต่ละตัว และ Flex ไม่มีปุ่มในแถวรายการ
 */
export function reminderList(input: ReminderListInput): messagingApi.Message {
  const tz = input.tz ?? env.APP_TIMEZONE;
  const now = input.now ?? new Date();
  const items = input.reminders.slice(0, LIST_MAX);

  if (items.length === 0) {
    return { type: 'text', text: 'ยังไม่มีการเตือนที่ตั้งไว้เลยค่ะ ลองพิมพ์ "เตือนกินยา 18.00" ดูนะคะ' };
  }

  const total = input.total ?? input.reminders.length;
  const hidden = total - items.length;

  const bubbles = items.map((r) => bubbleFor(r, tz, now));

  const message: messagingApi.FlexMessage = {
    type: 'flex',
    altText:
      `การเตือนที่ตั้งไว้ ${total} รายการ: ` +
      items.map((r) => r.title).slice(0, 3).join(', ') +
      (hidden > 0 ? ` และอื่นๆ` : ''),
    contents: { type: 'carousel', contents: bubbles },
  };

  return message;
}

function bubbleFor(r: Reminder, tz: string, now: Date): messagingApi.FlexBubble {
  const when = r.nextFireAtUtc
    ? formatThaiFriendly(r.nextFireAtUtc, tz, now)
    : 'ยังไม่กำหนดเวลา';

  const detail =
    r.kind === 'recurring'
      ? describeRecurrence(r.rrule, r.everyMinutes, r.fireAtMinuteLocal)
      : 'เตือนครั้งเดียว';

  const body: messagingApi.FlexComponent[] = [
    {
      type: 'text',
      text: r.title,
      weight: 'bold',
      size: SIZE.body,
      color: T.ink,
      wrap: true,
      maxLines: 3,
    },
    {
      type: 'text',
      text: when,
      size: SIZE.body,
      color: T.brand,
      weight: 'bold',
      margin: 'md',
      wrap: true,
    },
    {
      type: 'text',
      text: detail,
      size: SIZE.label,
      color: T.inkFaint,
      margin: 'xs',
      wrap: true,
    },
  ];

  if (r.note) {
    body.push({
      type: 'text',
      text: r.note,
      size: SIZE.label,
      color: T.inkSoft,
      margin: 'md',
      wrap: true,
      maxLines: 2,
    });
  }

  const footer: messagingApi.FlexComponent[] = [];

  // การเตือนซ้ำไม่ให้เปลี่ยนเวลาด้วย datetimepicker
  // เพราะการเปลี่ยน "เวลาของทุกวัน" ไม่ใช่การเลือกวันเวลาครั้งเดียว — ทำใน P6
  if (r.kind === 'once' && r.nextFireAtUtc) {
    footer.push({
      type: 'button',
      style: 'secondary',
      height: 'sm',
      action: {
        type: 'datetimepicker',
        label: 'เปลี่ยนเวลา',
        data: encodePostback({ a: 'rm.retime', id: r.id }),
        mode: 'datetime',
        initial: pickerFormat(r.nextFireAtUtc, tz),
        min: pickerFormat(now, tz),
      },
    });
  }

  footer.push({
    type: 'button',
    style: 'link',
    height: 'sm',
    color: T.danger,
    action: {
      type: 'postback',
      label: 'ลบ',
      data: encodePostback({ a: 'rm.cancel', id: r.id }),
      displayText: `ลบการเตือน: ${r.title}`,
    },
  });

  return {
    type: 'bubble',
    size: 'kilo',
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: body },
    footer: { type: 'box', layout: 'vertical', spacing: 'xs', paddingAll: 'md', contents: footer },
  };
}
