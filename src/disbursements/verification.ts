import { createHmac, timingSafeEqual } from 'crypto';

type Subject = { reference: string; amount: string; currency: string; approvedAt: Date; clientId: string };

/** Código que acompaña al PDF: HMAC de los datos esenciales, para poder comprobar que no fueron alterados. XXXX-XXXX-XXXX-XXXX */
export function verificationCode(secret: string, s: Subject): string {
  const hex = createHmac('sha256', secret).update(`${s.reference}|${s.amount}|${s.currency}|${s.approvedAt.toISOString()}|${s.clientId}`).digest('hex').slice(0, 16).toUpperCase();
  return hex.match(/.{4}/g)!.join('-');
}

export function codesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a.trim().toUpperCase());
  const y = Buffer.from(b.trim().toUpperCase());
  return x.length === y.length && timingSafeEqual(x, y);
}
