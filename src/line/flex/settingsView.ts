import type { messagingApi } from '@line/bot-sdk';
import type { User } from '@prisma/client';
import { T, SIZE } from './theme.js';
import { encodePostback } from '../postback.js';
import { formatMinuteOfDay, isInQuietHours } from '../../lib/time.js';

/** datetimepicker mode='time' ต้องการ 'HH:mm' */
function toPickerTime(minute: number): string {
  return formatMinuteOfDay(minute);
}

/**
 * หน้าตั้งค่า — ขอบเขต v1 แค่ช่วงเวลาเงียบ (มีผลกับการเตือนซ้ำ)
 * ไม่ทำเรื่อง plan/tz ในนี้เพราะ v1 ยังไม่มี flow เปลี่ยนแผน และ tz ผูกกับตอนสมัครแล้ว
 */
export function settingsView(user: User): messagingApi.FlexMessage {
  const hasQuietHours = user.quietHoursStart !== null && user.quietHoursStart !== user.quietHoursEnd;

  const body: messagingApi.FlexComponent[] = [
    { type: 'text', text: '⚙️ ตั้งค่า', weight: 'bold', size: SIZE.title, color: T.ink },
    {
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      spacing: 'sm',
      contents: [
        row('แผน', user.plan === 'pro' ? 'Pro' : 'Free'),
        row(
          'ช่วงเวลาเงียบ',
          hasQuietHours
            ? `${toPickerTime(user.quietHoursStart ?? 0)} - ${toPickerTime(user.quietHoursEnd ?? 0)}`
            : 'ปิดอยู่',
        ),
      ],
    },
    {
      type: 'text',
      text: 'ช่วงเวลาเงียบ: การเตือนซ้ำที่ตกในช่วงนี้จะถูกเลื่อนไปตอนสิ้นสุดช่วงแทนนะคะ',
      size: SIZE.label,
      color: T.inkFaint,
      wrap: true,
      margin: 'lg',
    },
  ];

  const footer: messagingApi.FlexComponent[] = hasQuietHours
    ? [
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'datetimepicker',
            label: 'ปรับเวลาเริ่ม',
            data: encodePostback({ a: 'settings.quiet_start' }),
            mode: 'time',
            initial: toPickerTime(user.quietHoursStart ?? 0),
          },
        },
        {
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'datetimepicker',
            label: 'ปรับเวลาสิ้นสุด',
            data: encodePostback({ a: 'settings.quiet_end' }),
            mode: 'time',
            initial: toPickerTime(user.quietHoursEnd ?? 0),
          },
        },
        {
          type: 'button',
          style: 'link',
          height: 'sm',
          color: T.danger,
          action: {
            type: 'postback',
            label: 'ปิดช่วงเวลาเงียบ',
            data: encodePostback({ a: 'settings.quiet_off' }),
            displayText: 'ปิดช่วงเวลาเงียบ',
          },
        },
      ]
    : [
        {
          type: 'button',
          style: 'primary',
          height: 'sm',
          color: T.brand,
          action: {
            type: 'postback',
            label: 'เปิดช่วงเวลาเงียบ',
            data: encodePostback({ a: 'settings.quiet_on' }),
            displayText: 'เปิดช่วงเวลาเงียบ',
          },
        },
      ];

  return {
    type: 'flex',
    altText: 'ตั้งค่า',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: body },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md', contents: footer },
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
