/**
 * ดึง URL ออกจากข้อความด้วย regex ล้วน ไม่ต้องผ่าน LLM
 *
 * ทำไมแยกจาก NLU: การจับลิงก์เป็นรูปแบบตายตัว (http/https) เรียก LLM มาทำเรื่องนี้
 * เสียเงินและช้าโดยไม่จำเป็น — ทำในโค้ดล้วนเร็วกว่าและแม่นกว่าด้วย
 */
const URL_RE = /https?:\/\/[^\s<>"'฀-๿]+/g;

export function extractUrls(text: string): string[] {
  const matches = text.match(URL_RE) ?? [];
  // ตัดวรรคตอนท้ายประโยคที่ติดมากับ URL เช่น "เช็คที่ https://a.co/x นะ" → ")" หรือ "." ท้ายสุด
  const cleaned = matches.map((u) => u.replace(/[)\].,!?"']+$/u, ''));
  return Array.from(new Set(cleaned));
}
