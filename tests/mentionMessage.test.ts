import { describe, expect, it } from 'vitest';
import { buildMentionMessage } from '../src/line/mentionMessage.js';

describe('buildMentionMessage', () => {
  it('สร้าง textV2 พร้อม substitution ครบทุกคน', () => {
    const msg = buildMentionMessage(
      [
        { userId: 'U1', displayName: 'โบ๊ท' },
        { userId: 'U2', displayName: 'นุช' },
      ],
      'ส่งรายงาน',
    );
    expect(msg.type).toBe('textV2');
    expect(msg.text).toContain('{m0}');
    expect(msg.text).toContain('{m1}');
    expect(msg.text).toContain('ส่งรายงาน');
    expect(msg.substitution?.m0).toEqual({
      type: 'mention',
      mentionee: { type: 'user', userId: 'U1' },
    });
    expect(msg.substitution?.m1).toEqual({
      type: 'mention',
      mentionee: { type: 'user', userId: 'U2' },
    });
  });

  it('คนเดียวก็ทำงาน', () => {
    const msg = buildMentionMessage([{ userId: 'U1', displayName: 'โบ๊ท' }], 'กินยา');
    expect(Object.keys(msg.substitution ?? {})).toEqual(['m0']);
  });
});
