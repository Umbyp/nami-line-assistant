import type { messagingApi } from '@line/bot-sdk';
import type { VaultKind } from '@prisma/client';
import { T, SIZE } from './theme.js';
import { encodePostback } from '../postback.js';
import { formatThaiFriendly } from '../../lib/time.js';
import { env } from '../../config/env.js';
import type { VaultSearchHit } from '../../vault/search.js';

export const VAULT_RESULT_MAX = 10;

const KIND_ICON: Record<VaultKind, string> = {
  text: '📝',
  link: '🔗',
  image: '🖼️',
  file: '📎',
};

const KIND_LABEL: Record<VaultKind, string> = {
  text: 'ข้อความ',
  link: 'ลิงก์',
  image: 'รูปภาพ',
  file: 'ไฟล์',
};

export interface VaultSearchResultInput {
  hits: VaultSearchHit[];
  /** ว่าง = โหมดดูของล่าสุด (ปุ่มเมนู "โน้ต-ไฟล์") ไม่ใช่การค้นหา — เปลี่ยนถ้อยคำให้เข้ากับบริบท */
  query: string;
  tz?: string;
  now?: Date;
}

/**
 * ผลค้นหาเป็น carousel — เหตุผลเดียวกับ reminderList
 * ปุ่ม "ส่งกลับมาในแชท" ต้องผูกกับแต่ละรายการ ซึ่ง Flex ไม่มีปุ่มในแถวรายการเดียว
 */
export function vaultSearchResult(input: VaultSearchResultInput): messagingApi.Message {
  const tz = input.tz ?? env.APP_TIMEZONE;
  const now = input.now ?? new Date();
  const hits = input.hits.slice(0, VAULT_RESULT_MAX);
  const isBrowsingRecent = input.query.trim() === '';

  if (hits.length === 0) {
    return {
      type: 'text',
      text: isBrowsingRecent
        ? 'ยังไม่มีของเก็บไว้เลยค่ะ ส่งรูป ไฟล์ หรือลิงก์มาได้เลย นามิจะเก็บให้นะคะ'
        : `หา "${input.query}" ไม่เจอเลยค่ะ ลองคำอื่นดูไหมคะ`,
    };
  }

  return {
    type: 'flex',
    altText: isBrowsingRecent
      ? `ของที่เก็บไว้ล่าสุด ${hits.length} รายการ`
      : `เจอ ${hits.length} รายการ: ${hits.map((h) => h.title ?? KIND_LABEL[h.kind]).slice(0, 3).join(', ')}`,
    contents: { type: 'carousel', contents: hits.map((h) => bubbleFor(h, tz, now)) },
  };
}

function bubbleFor(hit: VaultSearchHit, tz: string, now: Date): messagingApi.FlexBubble {
  const title = hit.title ?? KIND_LABEL[hit.kind];
  const when = formatThaiFriendly(hit.createdAt, tz, now);

  const body: messagingApi.FlexComponent[] = [
    {
      type: 'text',
      text: `${KIND_ICON[hit.kind]} ${title}`,
      weight: 'bold',
      size: SIZE.body,
      color: T.ink,
      wrap: true,
      maxLines: 3,
    },
    { type: 'text', text: when, size: SIZE.label, color: T.inkFaint, margin: 'sm' },
  ];

  // ข้อความ/ลิงก์: แสดงตัวอย่างเนื้อหา — ไฟล์/รูปไม่มีอะไรให้โชว์นอกจากชื่อ
  if ((hit.kind === 'text' || hit.kind === 'link') && hit.contentText) {
    body.push({
      type: 'text',
      text: hit.contentText,
      size: SIZE.label,
      color: T.inkSoft,
      wrap: true,
      maxLines: 3,
      margin: 'md',
    });
  }

  const footer: messagingApi.FlexComponent[] = [];

  if (hit.kind === 'link' && hit.contentText) {
    footer.push({
      type: 'button',
      style: 'primary',
      height: 'sm',
      color: T.brand,
      action: { type: 'uri', label: 'เปิดลิงก์', uri: hit.contentText },
    });
  } else if (hit.storageKey) {
    // รูป/ไฟล์: ต้องขอ URL ชั่วคราวก่อนถึงจะเปิดได้ (ไม่เก็บ URL ถาวรไว้ใน DB)
    footer.push({
      type: 'button',
      style: 'primary',
      height: 'sm',
      color: T.brand,
      action: {
        type: 'postback',
        label: hit.kind === 'image' ? 'ส่งรูปกลับมา' : 'ส่งไฟล์กลับมา',
        data: encodePostback({ a: 'vault.send', id: hit.id }),
        displayText: `ขอ${hit.kind === 'image' ? 'รูป' : 'ไฟล์'}: ${title}`,
      },
    });
  }

  return {
    type: 'bubble',
    size: 'kilo',
    body: { type: 'box', layout: 'vertical', paddingAll: 'lg', contents: body },
    ...(footer.length > 0
      ? { footer: { type: 'box', layout: 'vertical', paddingAll: 'md', contents: footer } }
      : {}),
  };
}
