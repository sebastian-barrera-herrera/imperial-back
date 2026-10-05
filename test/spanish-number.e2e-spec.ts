import { amountInWords, integerInWords } from '../src/common/spanish-number';

describe('Monto en palabras (documentos legales)', () => {
  it.each([
    [0, 'cero'], [1, 'uno'], [15, 'quince'], [21, 'veintiuno'], [30, 'treinta'], [31, 'treinta y uno'], [99, 'noventa y nueve'],
    [100, 'cien'], [101, 'ciento uno'], [250, 'doscientos cincuenta'], [999, 'novecientos noventa y nueve'],
    [1000, 'mil'], [1001, 'mil uno'], [2000, 'dos mil'], [21000, 'veintiún mil'], [31000, 'treinta y un mil'], [101000, 'ciento un mil'], [100000, 'cien mil'],
    [1_000_000, 'un millón'], [2_500_000, 'dos millones quinientos mil'], [21_000_000, 'veintiún millones'], [1_000_000_000, 'mil millones'], [999_999_999_999, 'novecientos noventa y nueve mil novecientos noventa y nueve millones novecientos noventa y nueve mil novecientos noventa y nueve'],
  ])('%i → %s', (n, words) => expect(integerInWords(n)).toBe(words));

  it('redacta el monto con moneda, centavos y concordancia', () => {
    expect(amountInWords(1, 'USD')).toBe('UN DÓLAR CON 00/100');
    expect(amountInWords(21, 'USD')).toBe('VEINTIÚN DÓLARES DE LOS ESTADOS UNIDOS DE AMÉRICA CON 00/100');
    expect(amountInWords(10050.25, 'USD')).toBe('DIEZ MIL CINCUENTA DÓLARES DE LOS ESTADOS UNIDOS DE AMÉRICA CON 25/100');
    expect(amountInWords(12500.5, 'USD')).toBe('DOCE MIL QUINIENTOS DÓLARES DE LOS ESTADOS UNIDOS DE AMÉRICA CON 50/100');
    expect(amountInWords(1_000_000, 'USD')).toBe('UN MILLÓN DE DÓLARES DE LOS ESTADOS UNIDOS DE AMÉRICA CON 00/100');
    expect(amountInWords(3_000_000, 'USD')).toBe('TRES MILLONES DE DÓLARES DE LOS ESTADOS UNIDOS DE AMÉRICA CON 00/100');
    expect(amountInWords(0.07, 'USD')).toContain('CON 07/100');
    expect(amountInWords(5, 'EUR')).toBe('CINCO EUR CON 00/100');
  });

  it('evita errores de coma flotante en los centavos', () => {
    expect(amountInWords(1.15, 'USD')).toContain('CON 15/100');
    expect(amountInWords(0.29, 'USD')).toContain('CON 29/100');
  });

  it('rechaza valores fuera de rango', () => {
    expect(() => integerInWords(-1)).toThrow(RangeError);
    expect(() => integerInWords(1e12)).toThrow(RangeError);
    expect(() => integerInWords(1.5)).toThrow(RangeError);
  });
});
