/**
 * สีและขนาดกลางของ Flex ทั้งหมด — อย่า hardcode สีในแต่ละ builder
 * LINE ไม่มี dark mode ให้ Flex จึงคุมคอนทราสต์เองได้
 */
export const T = {
  brand: '#2F6F4F', // เขียวเข้ม โทนเดียวกับชื่อ "นามิ"
  brandSoft: '#E8F1EC',
  ink: '#1F2A24',
  inkSoft: '#5B6B62',
  inkFaint: '#93A29A',
  line: '#E3E8E5',
  danger: '#C0392B',
  warn: '#B8860B',
  white: '#FFFFFF',
} as const;

export const SIZE = {
  label: 'xs',
  body: 'sm',
  title: 'lg',
  big: 'xl',
} as const;
