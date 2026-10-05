const UNITS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez', 'once', 'doce', 'trece', 'catorce', 'quince', 'dieciséis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte', 'veintiuno', 'veintidós', 'veintitrés', 'veinticuatro', 'veinticinco', 'veintiséis', 'veintisiete', 'veintiocho', 'veintinueve'];
const TENS = ['', '', '', 'treinta', 'cuarenta', 'cincuenta', 'sesenta', 'setenta', 'ochenta', 'noventa'];
const HUNDREDS = ['', 'ciento', 'doscientos', 'trescientos', 'cuatrocientos', 'quinientos', 'seiscientos', 'setecientos', 'ochocientos', 'novecientos'];

/** «uno» → «un» y «veintiuno» → «veintiún» cuando acompañan a un sustantivo o a «mil»/«millones». */
const apocope = (words: string) => words.replace(/veintiuno$/, 'veintiún').replace(/uno$/, 'un');

function below1000(n: number): string {
  if (n === 100) return 'cien';
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (r) parts.push(r < 30 ? UNITS[r] : TENS[Math.floor(r / 10)] + (r % 10 ? ` y ${UNITS[r % 10]}` : ''));
  return parts.join(' ');
}

function below1e6(n: number): string {
  const t = Math.floor(n / 1000);
  const r = n % 1000;
  const parts: string[] = [];
  if (t) parts.push(t === 1 ? 'mil' : `${apocope(below1000(t))} mil`);
  if (r) parts.push(below1000(r));
  return parts.join(' ');
}

/** Entero (0 – 999 999 999 999) en palabras, en minúsculas, sin apócope final. */
export function integerInWords(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= 1e12) throw new RangeError('Monto fuera de rango');
  if (n === 0) return 'cero';
  const millions = Math.floor(n / 1e6);
  const rest = n % 1e6;
  const parts: string[] = [];
  if (millions) parts.push(millions === 1 ? 'un millón' : `${apocope(below1e6(millions))} millones`);
  if (rest) parts.push(below1e6(rest));
  return parts.join(' ');
}

const CURRENCY_NAMES: Record<string, [string, string]> = {
  USD: ['dólar', 'dólares de los Estados Unidos de América'],
};

/** «DIEZ MIL CINCUENTA DÓLARES DE LOS ESTADOS UNIDOS DE AMÉRICA CON 25/100» (formato habitual de documentos legales). */
export function amountInWords(amount: number, currency: string): string {
  const cents = Math.round(amount * 100);
  const whole = Math.floor(cents / 100);
  const fraction = cents % 100;
  const [singular, plural] = CURRENCY_NAMES[currency] ?? [currency, currency];
  const words = apocope(integerInWords(whole));
  const exactMillions = whole >= 1e6 && whole % 1e6 === 0;
  const noun = whole === 1 ? singular : plural;
  const text = `${words}${exactMillions ? ' de' : ''} ${noun} con ${String(fraction).padStart(2, '0')}/100`;
  return text.toUpperCase();
}
