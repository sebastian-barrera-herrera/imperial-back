import * as path from 'path';
import PDFDocument from 'pdfkit';
import * as QRCode from 'qrcode';
import { amountInWords } from '../common/spanish-number';

export type ApprovalPdfData = {
  reference: string;
  issuedAt: Date;
  /** Fecha de solicitud que figura en el documento (solo fecha: se formatea en UTC). */
  requestDate: Date;
  approvedAt: Date;
  approvedBy?: string | null;
  /** Emisor del documento, lugar de emisión y firmante, definidos por el superadmin. */
  issuerName: string;
  issuePlace: string;
  signerName?: string | null;
  signerTitle?: string | null;
  notes?: string | null;
  /** Borrador: aún no habilitado para el cliente (lleva sello y no se puede verificar). */
  draft?: boolean;
  statusLabel: string;
  amount: number;
  currency: string;
  concept: string;
  beneficiary: { name: string; email: string; idMasked?: string | null };
  bank?: { name?: string | null; last4?: string | null };
  caseNumber?: string | null;
  events: { at: Date; status: string; note?: string | null; by?: string | null }[];
  verification: { code: string; url: string };
  timeZone: string;
};

const NAVY = '#1d344a';
const GOLD = '#b8903f';
const INK = '#1f2937';
const MUTED = '#56667d';
const RULE = '#cbd5e1';
const CREAM = '#f9f8e1';
const ASSETS = path.resolve(__dirname, '../../assets/brand');
const LOGO = path.join(ASSETS, 'logo-navy.png');
const MARK = path.join(ASSETS, 'mark-navy.png');

const MARGIN_X = 56;
const FOOTER_TOP = 52; // distancia del pie al borde inferior de la página

/** Documento de aprobación de desembolso: membrete con logo, marca de agua, resumen, partes, trámite, condiciones y verificación (QR). */
export async function renderApprovalPdf(d: ApprovalPdfData): Promise<Buffer> {
  const qr = await QRCode.toBuffer(d.verification.url, { margin: 1, width: 260, color: { dark: NAVY, light: '#ffffff' } });
  const fmtDate = (v: Date) => new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric', timeZone: d.timeZone }).format(v);
  const fmtDateOnly = (v: Date) => new Intl.DateTimeFormat('es', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' }).format(v);
  const fmtDateTime = (v: Date) => new Intl.DateTimeFormat('es', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: d.timeZone }).format(v);
  const money = `${d.currency} ${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(d.amount)}`;

  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: 50, bottom: 70, left: MARGIN_X, right: MARGIN_X },
    bufferPages: true,
    info: {
      Title: `Documento de aprobación de desembolso ${d.reference}`,
      Author: 'Imperial Law Group',
      Subject: `Aprobación de la solicitud ${d.reference}`,
      Keywords: `desembolso, aprobación, ${d.reference}`,
      Creator: 'Imperial Law Group',
    },
    displayTitle: true,
  });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const finished = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  const W = doc.page.width;
  const L = MARGIN_X;
  const R = W - MARGIN_X;
  const CW = R - L;
  const bottomLimit = () => doc.page.height - 66;

  const watermark = () => {
    doc.save();
    doc.opacity(0.055);
    doc.image(MARK, (W - 400) / 2, (doc.page.height - 360) / 2, { width: 400 });
    doc.restore();
  };
  const draftStamp = () => {
    if (!d.draft) return;
    doc.save();
    doc.opacity(0.14);
    doc.rotate(-32, { origin: [W / 2, doc.page.height / 2] });
    doc.font('Helvetica-Bold').fontSize(86).fillColor('#b91c1c').text('BORRADOR', 0, doc.page.height / 2 - 40, { width: W, align: 'center', lineBreak: false });
    doc.restore();
  };
  watermark();
  draftStamp();
  doc.on('pageAdded', () => {
    watermark();
    draftStamp();
    // Cabecera mínima de continuación (no desplaza el cursor del contenido).
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(`Imperial Law Group · ${d.reference} · continuación`, L, 28, { width: CW, lineBreak: false });
    doc.x = L;
    doc.y = 50;
  });

  const ensureSpace = (h: number) => {
    if (doc.y + h > bottomLimit()) doc.addPage();
  };

  // ── Membrete ──
  doc.image(LOGO, L, 44, { height: 64 });
  doc.font('Times-Bold').fontSize(17).fillColor(NAVY).text('IMPERIAL LAW GROUP', L + 76, 58, { characterSpacing: 2.2, lineBreak: false });
  doc.font('Times-Italic').fontSize(9.5).fillColor(MUTED).text('Recuperación de capital con respaldo jurídico', L + 76, 80, { lineBreak: false });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text('REFERENCIA', R - 160, 54, { width: 160, align: 'right', characterSpacing: 1, lineBreak: false });
  doc.font('Helvetica-Bold').fontSize(13).fillColor(NAVY).text(d.reference, R - 160, 65, { width: 160, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`${d.issuePlace}`, R - 200, 82, { width: 200, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(8).fillColor(MUTED).text(`Emitido el ${fmtDate(d.issuedAt)}`, R - 200, 93, { width: 200, align: 'right', lineBreak: false });
  doc.moveTo(L, 118).lineTo(R, 118).lineWidth(1.6).strokeColor(NAVY).stroke();
  doc.moveTo(L, 122).lineTo(R, 122).lineWidth(0.5).strokeColor(GOLD).stroke();

  // ── Título ──
  doc.font('Times-Bold').fontSize(16).fillColor(NAVY).text('DOCUMENTO DE APROBACIÓN DE DESEMBOLSO', L, 144, { width: CW, align: 'center', characterSpacing: 1.1 });
  doc.font('Times-Italic').fontSize(10).fillColor(MUTED).text('Constancia de aprobación de la solicitud de desembolso', L, doc.y + 2, { width: CW, align: 'center' });

  // ── Resumen ──
  const cardY = doc.y + 6;
  const cardH = 82;
  doc.roundedRect(L, cardY, CW, cardH, 6).fillAndStroke(CREAM, GOLD);
  doc.fillColor(MUTED).font('Helvetica').fontSize(7.5).text('MONTO APROBADO', L + 16, cardY + 14, { characterSpacing: 1, lineBreak: false });
  doc.font('Times-Bold').fontSize(25).fillColor(NAVY).text(money, L + 16, cardY + 26, { lineBreak: false });
  doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(amountInWords(d.amount, d.currency), L + 16, cardY + 56, { width: CW * 0.58, lineGap: 1.5 });
  const colX = L + CW * 0.66;
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text('ESTADO ACTUAL', colX, cardY + 12, { characterSpacing: 1, lineBreak: false });
  doc.font('Times-Bold').fontSize(12).fillColor(INK).text(d.statusLabel, colX, cardY + 26, { lineBreak: false });
  doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text('FECHA DE APROBACIÓN', colX, cardY + 45, { characterSpacing: 1, lineBreak: false });
  doc.font('Times-Bold').fontSize(12).fillColor(INK).text(fmtDate(d.approvedAt), colX, cardY + 56, { width: R - colX - 12, lineBreak: false });
  doc.x = L;
  doc.y = cardY + cardH + 6;

  // ── Utilidades de maquetación ──
  const section = (title: string) => {
    ensureSpace(60);
    doc.y += 5;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(NAVY).text(title, L, doc.y, { characterSpacing: 1.3, lineBreak: false });
    const y = doc.y + 11;
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.6).strokeColor(RULE).stroke();
    doc.x = L;
    doc.y = y + 6;
  };
  const kv = (label: string, value: string) => {
    const vx = L + 146;
    const vw = CW - 146;
    doc.font('Times-Roman').fontSize(10.5);
    const h = Math.max(doc.heightOfString(value, { width: vw }), 13);
    ensureSpace(h + 6);
    const y = doc.y;
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED).text(label.toUpperCase(), L, y + 2.5, { width: 136, characterSpacing: 0.6 });
    doc.font('Times-Roman').fontSize(10.5).fillColor(INK).text(value, vx, y, { width: vw });
    doc.x = L;
    doc.y = y + h + 6;
  };
  const paragraph = (text: string) => {
    doc.font('Times-Roman').fontSize(10.5).fillColor(INK);
    ensureSpace(doc.heightOfString(text, { width: CW, align: 'justify', lineGap: 2.5 }) + 4);
    doc.text(text, L, doc.y, { width: CW, align: 'justify', lineGap: 2.5 });
    doc.x = L;
  };

  // ── I. Partes y cuenta de destino (dos columnas) ──
  section('I.  PARTES Y CUENTA DE DESTINO');
  const colW = (CW - 28) / 2;
  const field = (x: number, y: number, label: string, value: string) => {
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(label.toUpperCase(), x, y, { width: colW, characterSpacing: 0.7, lineBreak: false });
    doc.font('Times-Roman').fontSize(10.5).fillColor(INK);
    const h = doc.heightOfString(value, { width: colW });
    doc.text(value, x, y + 9.5, { width: colW });
    return 9.5 + h + 4;
  };
  const left: [string, string][] = [['Beneficiario', d.beneficiary.name], ['Correo electrónico', d.beneficiary.email]];
  if (d.beneficiary.idMasked) left.splice(1, 0, ['Documento de identidad', d.beneficiary.idMasked]);
  const right: [string, string][] = [
    ['Entidad financiera', d.bank?.name || 'No registrada'],
    ['Cuenta de destino (últimos 4 dígitos)', d.bank?.last4 ? `•••• •••• ${d.bank.last4}` : 'No registrada'],
    ['Emisor', d.issuerName],
  ];
  ensureSpace(96);
  let rowY = doc.y;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const hl = left[i] ? field(L, rowY, left[i][0], left[i][1]) : 0;
    const hr = right[i] ? field(L + colW + 28, rowY, right[i][0], right[i][1]) : 0;
    rowY += Math.max(hl, hr);
  }
  doc.x = L;
  doc.y = rowY;

  // ── II. Objeto ──
  section('II.  OBJETO DE LA APROBACIÓN');
  const caseText = d.caseNumber ? `, vinculada al caso N.º ${d.caseNumber}` : '';
  const approver = d.approvedBy ? `, por ${d.approvedBy}` : '';
  paragraph(
    `Imperial Law Group deja constancia de que la solicitud de desembolso N.º ${d.reference}, presentada el ${fmtDateOnly(d.requestDate)} por ${d.beneficiary.name} por concepto de «${d.concept}»${caseText}, ` +
      `fue APROBADA el ${fmtDate(d.approvedAt)}${approver}, por un monto de ${money}, conforme al detalle de este documento.`,
  );
  if (d.notes) {
    doc.y += 3;
    doc.font('Times-Italic').fontSize(10).fillColor(INK);
    ensureSpace(doc.heightOfString(`Observaciones: ${d.notes}`, { width: CW, lineGap: 2 }) + 4);
    doc.text(`Observaciones: ${d.notes}`, L, doc.y, { width: CW, lineGap: 2 });
    doc.x = L;
  }

  // ── IV. Trámite ──
  section(`III.  TRÁMITE  (hora ${d.timeZone})`);
  const cDate = 92;
  const cStatus = 92;
  const cNote = CW - cDate - cStatus;
  const rowHeight = (e: ApprovalPdfData['events'][number]) => {
    doc.font('Times-Roman').fontSize(9.5);
    return Math.max(doc.heightOfString(e.note ? `${e.note}${e.by ? ` — ${e.by}` : ''}` : e.by ?? '', { width: cNote - 8 }), 12) + 7;
  };
  ensureSpace(24);
  const headY = doc.y;
  doc.rect(L, headY, CW, 17).fill('#eef2f6');
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY);
  doc.text('FECHA', L + 6, headY + 5, { width: cDate - 6, characterSpacing: 0.8, lineBreak: false });
  doc.text('ESTADO', L + cDate, headY + 5, { width: cStatus, characterSpacing: 0.8, lineBreak: false });
  doc.text('DETALLE', L + cDate + cStatus, headY + 5, { width: cNote, characterSpacing: 0.8, lineBreak: false });
  doc.y = headY + 17;
  for (const e of d.events) {
    const h = rowHeight(e);
    ensureSpace(h);
    const y = doc.y;
    doc.font('Times-Roman').fontSize(9.5).fillColor(INK);
    doc.text(fmtDateTime(e.at), L + 6, y + 4.5, { width: cDate - 6, lineBreak: false });
    doc.font('Times-Bold').text(e.status, L + cDate, y + 4.5, { width: cStatus - 4, lineBreak: false });
    doc.font('Times-Roman').text(e.note ? `${e.note}${e.by ? ` — ${e.by}` : ''}` : e.by ?? '', L + cDate + cStatus, y + 4.5, { width: cNote - 8 });
    doc.moveTo(L, y + h).lineTo(R, y + h).lineWidth(0.4).strokeColor(RULE).stroke();
    doc.x = L;
    doc.y = y + h;
  }

  // ── V. Condiciones ──
  section('IV.  CONDICIONES');
  const clauses = [
    'La aprobación acredita que la solicitud superó la revisión documental y jurídica del despacho; no constituye garantía de pago de terceros ni título valor.',
    'El desembolso efectivo depende de los fondos recuperados y de los tiempos de la entidad financiera; el estado se informa en la plataforma.',
    'Los datos personales y bancarios se tratan conforme a la Política de Privacidad de Imperial Law Group. Si algún dato no coincide con su información, comuníquese con el despacho.',
    'La autenticidad y vigencia se comprueban con el código de verificación indicado más abajo; un documento sin código válido o con datos alterados carece de efecto.',
  ];
  clauses.forEach((c, i) => {
    doc.font('Times-Roman').fontSize(9.3);
    const h = doc.heightOfString(c, { width: CW - 22, align: 'justify', lineGap: 1.6 });
    ensureSpace(h + 5);
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor(GOLD).text(`${i + 1}.`, L, y + 1, { width: 18, lineBreak: false });
    doc.font('Times-Roman').fontSize(9.3).fillColor(INK).text(c, L + 22, y, { width: CW - 22, align: 'justify', lineGap: 1.6 });
    doc.x = L;
    doc.y = y + h + 4;
  });

  // ── Firma y verificación ──
  ensureSpace(84);
  const blockY = doc.y + 8;
  doc.moveTo(L, blockY + 48).lineTo(L + 190, blockY + 48).lineWidth(0.7).strokeColor(NAVY).stroke();
  doc.font('Times-Bold').fontSize(10.5).fillColor(NAVY).text(d.signerName || 'Equipo jurídico', L, blockY + 53, { width: 200, lineBreak: false });
  doc.font('Times-Roman').fontSize(9.5).fillColor(MUTED).text(d.signerTitle ? `${d.signerTitle} · Imperial Law Group` : 'Imperial Law Group', L, blockY + 66, { width: 200, lineBreak: false });
  doc.image(qr, R - 74, blockY - 2, { width: 74 });
  const vx = R - 74 - 14 - 210;
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor(NAVY).text('VERIFICACIÓN DE AUTENTICIDAD', vx, blockY + 2, { width: 210, align: 'right', characterSpacing: 0.9, lineBreak: false });
  doc.font('Times-Roman').fontSize(8.5).fillColor(MUTED).text('Escanee el código QR o ingrese el código en la página de verificación del sitio.', vx, blockY + 15, { width: 210, align: 'right' });
  doc.font('Courier-Bold').fontSize(11).fillColor(INK).text(d.verification.code, vx, blockY + 38, { width: 210, align: 'right', lineBreak: false });
  doc.font('Helvetica').fontSize(6.5).fillColor(MUTED).text(d.verification.url.replace(/^https?:\/\//, ''), vx, blockY + 53, { width: 210, align: 'right' });

  // ── Pie en todas las páginas ──
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(i);
    const y = doc.page.height - FOOTER_TOP;
    doc.page.margins.bottom = 0; // escribir dentro del margen inferior sin crear páginas nuevas
    doc.moveTo(L, y).lineTo(R, y).lineWidth(0.5).strokeColor(RULE).stroke();
    doc.font('Helvetica').fontSize(7).fillColor(MUTED).text(`Imperial Law Group · ${d.issuePlace} · Emitido el ${fmtDate(d.issuedAt)} · Verificación ${d.verification.code}`, L, y + 7, { width: CW - 90, lineBreak: false });
    doc.text(`Página ${i + 1} de ${range.count}`, R - 80, y + 7, { width: 80, align: 'right', lineBreak: false });
    doc.font('Helvetica').fontSize(6.5).text('Documento informativo emitido por la plataforma de Imperial Law Group. Las cifras y fechas corresponden al estado de la solicitud al momento de la emisión.', L, y + 19, { width: CW, lineBreak: false });
  }
  doc.end();
  return finished;
}
