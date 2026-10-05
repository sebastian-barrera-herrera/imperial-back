export type DetectedImage = { mime: string; extension: string };

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Solo imágenes ráster (JPG, PNG, WebP), detectadas por los primeros bytes. No se admite SVG: puede contener scripts. */
export function detectImageType(buffer: Buffer): DetectedImage | null {
  if (buffer.length < 12) return null;
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', extension: '.jpg' };
  if (buffer.subarray(0, 8).equals(PNG)) return { mime: 'image/png', extension: '.png' };
  if (buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return { mime: 'image/webp', extension: '.webp' };
  return null;
}
