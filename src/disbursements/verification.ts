import { createHash, createHmac, timingSafeEqual } from 'crypto';

/** Datos del documento que define el superadmin; todos forman parte de la huella que cubre el código de verificación. */
export type DocumentFields = {
  issuerName: string;
  signerName: string | null;
  signerTitle: string | null;
  financialEntity: string;
  accountLast4: string | null;
  /** YYYY-MM-DD */
  requestDate: string;
  issuePlace: string;
  notes: string | null;
};

type Subject = { reference: string; amount: string; currency: string; approvedAt: Date; clientId: string; fields: DocumentFields };

/** Huella estable de los datos del documento (el orden de las claves es fijo). */
export function documentFingerprint(f: DocumentFields): string {
  const ordered = [f.issuerName, f.signerName ?? '', f.signerTitle ?? '', f.financialEntity, f.accountLast4 ?? '', f.requestDate, f.issuePlace, f.notes ?? ''];
  return createHash('sha256').update(JSON.stringify(ordered)).digest('hex');
}

/**
 * Código que acompaña al PDF: HMAC del número, monto, moneda, fecha de aprobación, cliente y datos del documento.
 * Si alguno cambia, el código cambia y los PDF emitidos antes dejan de verificarse. Formato XXXX-XXXX-XXXX-XXXX.
 */
export function verificationCode(secret: string, s: Subject): string {
  const payload = `${s.reference}|${s.amount}|${s.currency}|${s.approvedAt.toISOString()}|${s.clientId}|${documentFingerprint(s.fields)}`;
  const hex = createHmac('sha256', secret).update(payload).digest('hex').slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}

export function codesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a.trim().toUpperCase());
  const y = Buffer.from(b.trim().toUpperCase());
  return x.length === y.length && timingSafeEqual(x, y);
}
