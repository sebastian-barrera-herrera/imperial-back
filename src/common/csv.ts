import { StreamableFile } from '@nestjs/common';

const FORMULA_CHARS = /^[=+\-@\t\r]/;

function cell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = value instanceof Date ? value.toISOString() : String(value);
  // Evita inyección de fórmulas al abrir el CSV en Excel/Sheets (solo para texto, no para números).
  if (typeof value === 'string' && FORMULA_CHARS.test(text)) text = `'${text}`;
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** CSV con BOM UTF-8 para que Excel respete tildes y eñes. */
export function toCsvFile(filename: string, headers: string[], rows: unknown[][]): StreamableFile {
  const body = [headers, ...rows].map((row) => row.map(cell).join(',')).join('\r\n');
  return new StreamableFile(Buffer.from('﻿' + body, 'utf8'), {
    type: 'text/csv; charset=utf-8',
    disposition: `attachment; filename="${filename}"`,
  });
}
