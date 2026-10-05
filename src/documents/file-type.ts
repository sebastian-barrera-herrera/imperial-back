export type DetectedFile = { mime: string; extension: string };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Detecta el tipo real por los primeros bytes; el Content-Type que envía el navegador no es confiable. */
export function detectFileType(buffer: Buffer): DetectedFile | null {
  if (buffer.length < 8) return null;
  if (buffer.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', extension: '.pdf' };
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', extension: '.jpg' };
  if (buffer.subarray(0, 8).equals(PNG)) return { mime: 'image/png', extension: '.png' };
  return null;
}
