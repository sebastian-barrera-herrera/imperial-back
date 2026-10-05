/**
 * Métricas de inversión (valor, ganancia, rendimiento, historial). Funciones puras: reciben series de
 * valoraciones y posiciones ya cargadas y devuelven números listos para mostrar.
 * Las fechas son "YYYY-MM-DD" (UTC) para evitar corrimientos por zona horaria.
 * Son cifras informativas para el cliente; la contabilidad oficial es la del despacho.
 */
export type Point = { date: string; unitValue: number };
export type PositionInput = {
  amount: number;
  units: number;
  unitCost: number;
  investedAt: string;
  status: 'ACTIVE' | 'REDEEMED';
  redeemedAt: string | null;
  redeemedValue: number | null;
};

const DAY_MS = 86_400_000;

export const round = (n: number, digits = 2) => {
  const f = 10 ** digits;
  return Math.round((n + Number.EPSILON) * f) / f;
};
export const dayKey = (d: Date) => d.toISOString().slice(0, 10);
export const parseDay = (s: string) => new Date(`${s}T00:00:00.000Z`);
export const daysBetween = (from: string, to: string) => Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY_MS);
export const shiftDay = (day: string, delta: number) => dayKey(new Date(parseDay(day).getTime() + delta * DAY_MS));

/** Último valor unitario con fecha <= `day` (la serie debe venir ordenada por fecha ascendente). */
export function valueAt(series: Point[], day: string): number | null {
  let found: number | null = null;
  for (const p of series) {
    if (p.date <= day) found = p.unitValue;
    else break;
  }
  return found;
}

export function positionMetrics(p: PositionInput, series: Point[], today: string) {
  const redeemed = p.status === 'REDEEMED' && p.redeemedValue !== null;
  const currentValue = redeemed ? (p.redeemedValue as number) : p.units * (valueAt(series, today) ?? p.unitCost);
  const currentUnitValue = redeemed ? currentValue / p.units : (valueAt(series, today) ?? p.unitCost);
  const end = redeemed && p.redeemedAt ? p.redeemedAt : today;
  const daysHeld = Math.max(0, daysBetween(p.investedAt, end));
  const pnl = currentValue - p.amount;
  const returnPct = p.amount > 0 ? (pnl / p.amount) * 100 : 0;
  // Anualizar un periodo corto exagera el resultado: solo se calcula con 30+ días de tenencia.
  const annualizedPct = daysHeld >= 30 && p.amount > 0 && currentValue > 0 ? (Math.pow(currentValue / p.amount, 365 / daysHeld) - 1) * 100 : null;
  return {
    currentUnitValue: round(currentUnitValue, 4),
    currentValue: round(currentValue),
    pnl: round(pnl),
    returnPct: round(returnPct),
    daysHeld,
    annualizedPct: annualizedPct === null ? null : round(annualizedPct),
  };
}

/** Evolución del valor de mercado de las posiciones abiertas en cada fecha relevante, junto al capital aportado. */
export function portfolioHistory(positions: (PositionInput & { opportunityId: string })[], seriesByOpp: Map<string, Point[]>, today: string) {
  if (positions.length === 0) return [];
  const start = positions.reduce((min, p) => (p.investedAt < min ? p.investedAt : min), positions[0].investedAt);
  const dates = new Set<string>([today]);
  for (const p of positions) {
    dates.add(p.investedAt);
    if (p.redeemedAt) dates.add(p.redeemedAt);
    for (const point of seriesByOpp.get(p.opportunityId) ?? []) dates.add(point.date);
  }
  return [...dates]
    .filter((d) => d >= start && d <= today)
    .sort()
    .map((date) => {
      let value = 0;
      let invested = 0;
      for (const p of positions) {
        const open = p.investedAt <= date && (!p.redeemedAt || date < p.redeemedAt);
        if (!open) continue;
        value += p.units * (valueAt(seriesByOpp.get(p.opportunityId) ?? [], date) ?? p.unitCost);
        invested += p.amount;
      }
      return { date, value: round(value), invested: round(invested) };
    });
}

/** Estadísticas tipo "cotización" de una serie de valores unitarios. */
export function opportunityStats(series: Point[], today: string) {
  if (series.length === 0) return null;
  const first = series[0];
  const latest = series[series.length - 1];
  const previous = series.length > 1 ? series[series.length - 2] : null;
  const pct = (base: number | null) => (base !== null && base > 0 ? round((latest.unitValue / base - 1) * 100) : null);
  const year = Number(today.slice(0, 4));
  const values = series.map((s) => s.unitValue);
  return {
    inceptionDate: first.date,
    inceptionValue: first.unitValue,
    latestDate: latest.date,
    latestValue: latest.unitValue,
    previousValue: previous?.unitValue ?? null,
    change: previous ? round(latest.unitValue - previous.unitValue, 4) : null,
    changePct: previous ? pct(previous.unitValue) : null,
    oneMonthPct: pct(valueAt(series, shiftDay(today, -30))),
    threeMonthPct: pct(valueAt(series, shiftDay(today, -90))),
    ytdPct: pct(valueAt(series, `${year - 1}-12-31`) ?? first.unitValue),
    sinceInceptionPct: pct(first.unitValue),
    high: Math.max(...values),
    low: Math.min(...values),
  };
}
