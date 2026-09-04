import type { messagingApi } from '@line/bot-sdk';
import type { ReminderDraft } from '@prisma/client';
import { T, SIZE } from './theme.js';
import { encodePostback } from '../postback.js';
import { formatThaiFriendly } from '../../lib/time.js';
import { describeRecurrence } from '../../scheduler/nextOccurrence.js';
import { env } from '../../config/env.js';
import { confirmableItems, readDraftItems } from '../../reminders/draftService.js';

/**
 * ให้ผู้ใช้ยืนยันก่อนบันทึกจริง (ตามสเปก: อ่านรูป → ตั้งเตือนหลายรายการ → ยืนยันก่อนบันทึก)
 *
 * เป็น bubble เดียว (ไม่ใช่ carousel) เพราะต้องกดยืนยัน "ทั้งชุด" ในคราวเดียว
 * ไม่ใช่แก้ไขรายตัว — แก้ทีหลังได้ผ่านปุ่มแก้ไข/ลบในรายการเตือนปกติ (rm.retime/rm.cancel)
 */
export function imageReminderReview(draft: ReminderDraft): messagingApi.FlexMessage {
  const tz = env.APP_TIMEZONE;
  const now = new Date();
  const { items, unclearNotes } = readDraftItems(draft);
  const ok = confirmableItems(items);
  const failed = items.filter((i) => i.problem !== null);

  const body: messagingApi.FlexComponent[] = [
    {
      type: 'text',
      text: `📷 เจอ ${ok.length} รายการที่ควรตั้งเตือนค่ะ`,
      weight: 'bold',
      size: SIZE.title,
      color: T.ink,
      wrap: true,
    },
  ];

  if (ok.length > 0) {
    body.push({
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      spacing: 'md',
      contents: ok.map((item) => {
        const when =
          item.kind === 'once' && item.dueAtUtc
            ? formatThaiFriendly(item.dueAtUtc, tz, now)
            : describeRecurrence(item.rrule, null, item.fireAtMinuteLocal);
        return {
          type: 'box',
          layout: 'vertical',
          contents: [
            { type: 'text', text: item.title, size: SIZE.body, weight: 'bold', color: T.ink, wrap: true },
            { type: 'text', text: when, size: SIZE.label, color: T.brand, wrap: true },
          ],
        };
      }),
    });
  }

  if (failed.length > 0) {
    body.push(
      notice(
        `อ่านไม่ออก ${failed.length} รายการค่ะ: ${failed.map((f) => f.problem).join(' · ')}`,
        T.warn,
      ),
    );
  }

  if (unclearNotes.length > 0) {
    body.push(notice(`จุดที่ไม่มั่นใจ: ${unclearNotes.join(' · ')} — ตรวจสอบก่อนใช้จริงนะคะ`, T.warn));
  }

  const footer: messagingApi.FlexComponent[] =
    ok.length > 0
      ? [
          {
            type: 'button',
            style: 'primary',
            height: 'sm',
            color: T.brand,
            action: {
              type: 'postback',
              label: `ยืนยันทั้งหมด (${ok.length} รายการ)`,
              data: encodePostback({ a: 'draft.confirm', id: draft.id }),
              displayText: 'ยืนยันตั้งเตือนตามที่อ่านได้จากรูป',
            },
          },
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'ไม่ต้อง',
              data: encodePostback({ a: 'draft.discard', id: draft.id }),
              displayText: 'ไม่ต้องตั้งเตือนจากรูปนี้',
            },
          },
        ]
      : [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: {
              type: 'postback',
              label: 'รับทราบ',
              data: encodePostback({ a: 'draft.discard', id: draft.id }),
              displayText: 'รับทราบ',
            },
          },
        ];

  return {
    type: 'flex',
    altText:
      ok.length > 0
        ? `เจอ ${ok.length} รายการที่ควรตั้งเตือนจากรูปค่ะ กดยืนยันเพื่อบันทึกนะคะ`
        : 'อ่านรูปแล้วแต่ยังไม่แน่ใจว่าควรตั้งเตือนอะไรค่ะ',
    contents: {
      type: 'bubble',
      body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: body },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', paddingAll: 'md', contents: footer },
    },
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
