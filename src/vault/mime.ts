/** เดา MIME จากชนิด message ของ LINE (SDK ไม่ส่ง content-type ของไฟล์จริงมาให้) */
export function mimeForMessageType(
  type: 'image' | 'video' | 'audio',
): string {
  switch (type) {
    case 'image':
      return 'image/jpeg';
    case 'video':
      return 'video/mp4';
    case 'audio':
      return 'audio/m4a';
  }
}

/** เดาจากนามสกุลไฟล์ ใช้กับ message ชนิด file เท่านั้น (มี fileName มาให้) */
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  zip: 'application/zip',
  txt: 'text/plain',
  csv: 'text/csv',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
};

export function mimeForFileName(fileName: string): string {
  const ext = fileName.includes('.') ? fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase() : '';
  return EXT_MIME[ext] ?? 'application/octet-stream';
}
