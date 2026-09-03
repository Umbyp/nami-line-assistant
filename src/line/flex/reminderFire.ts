import type { messagingApi } from '@line/bot-sdk';
import { T, SIZE } from './theme.js';
import { encodePostback } from '../postback.js';
import { formatThaiFriendly } from '../../lib/time.js';
import { describeRecurrence } from '../../scheduler/nextOccurrence.js';
import { env } from '../../config/env.js';

export interface ReminderFireInput {
  occurrenceId: string;
  reminderId: string;
  title: string;
  note?: string | null;
  fireAtUtc: Date;
  isRecurring: boolean;
  rrule?: string | null;
  everyMinutes?: number | null;
  fireAtMinuteLocal?: number | null;
  /** ชื่อคนที่ถูกมอบหมาย แสดงในการ์ด (การ @mention จริงทำใน P5) */
  assigneeLabels?: string[];
  tz?: string;
  now?: Date;
}

/**
 * การ์ดตอนนามิยิงเตือน — เป็น push ทั้งหมด (มีค่าใช้จ่าย)
 *
 * ปุ่มเป็น postback ล้วน เพราะแก้ข้อความที่ส่งไปแล้วไม่ได้
 * ปุ่มเลื่อนพา occurrenceId ไป ไม่ใช่ reminderId
 * เพราะ "เลื่อน" หมายถึงเลื่อนรอบนี้ ไม่ใช่เปลี่ยนตารางทั้งชุด
 */
export function reminderFire(input: ReminderFireInput): messagingApi.FlexMessage {
  const tz = input.tz ?? env.APP_TIMEZONE;
  const now = input.now ?? new Date();

  const body: messagingApi.FlexComponent[] = [
    {
      type: 'text',
      text: input.title,
      weight: 'bold',
      size: SIZE.big,
      color: T.ink,
      wrap: true,
    },
  ];

  if (input.note) {
    body.push({
      type: 'text',
      text: input.note,
      size: SIZE.body,
      color: T.inkSoft,
      wrap: true,
      margin: 'sm',
    });
  }

  const meta: string[] = [formatThaiFriendly(input.fireAtUtc, tz, now)];
  if (input.isRecurring) {
    meta.push(describeRecurrence(input.rrule, input.everyMinutes, input.fireAtMinuteLocal));
  }
  body.push({
    type: 'text',
    text: meta.join(' · '),
    size: SIZE.label,
    color: T.inkFaint,
    margin: 'md',
    wrap: true,
  });

  if (input.assigneeLabels?.length) {
    body.push({
      type: 'text',
      text: `มอบหมาย: ${input.assigneeLabels.join(', ')}`,
      size: SIZE.label,
      color: T.inkSoft,
      margin: 'sm',
      wrap: true,
    });
  }

  return {
    type: 'flex',
    altText: `⏰ ${input.title}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box',
        layout: 'horizontal',
        backgroundColor: T.brand,
        paddingAll: 'md',
        contents: [
          { type: 'text', text: '⏰ ถึงเวลาแล้ว', color: T.white, weight: 'bold', size: SIZE.body },
        ],
      },
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: body },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        paddingAll: 'md',
        contents: [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            color: T.brand,
            action: {
              type: 'postback',
              label: 'เสร็จแล้ว',
              data: encodePostback({ a: 'rm.done', oid: input.occurrenceId }),
              displayText: 'เสร็จแล้ว',
            },
          },
          {
            type: 'box',
            layout: 'horizontal',
            spacing: 'sm',
            contents: [
              snoozeButton(input.occurrenceId, 10, 'เลื่อน 10 นาที'),
              snoozeButton(input.occurrenceId, 60, 'เลื่อน 1 ชม.'),
            ],
          },
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'ปิดการเตือนนี้',
              data: encodePostback({ a: 'rm.off', id: input.reminderId }),
              displayText: 'ปิดการเตือนนี้',
            },
          },
        ],
      },
    },
  };
}

function snoozeButton(occurrenceId: string, minutes: number, label: string): messagingApi.FlexComponent {
  return {
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: {
      type: 'postback',
      label,
      data: encodePostback({ a: 'rm.snooze', oid: occurrenceId, m: minutes }),
      displayText: label,
    },
  };
}
