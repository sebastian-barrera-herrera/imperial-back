import { opportunityStats, portfolioHistory, positionMetrics, shiftDay, valueAt, type Point, type PositionInput } from '../src/investments/metrics';

// Pruebas puras (sin base de datos) de las fórmulas de rendimiento.
const series: Point[] = [
  { date: '2026-01-01', unitValue: 100 },
  { date: '2026-04-01', unitValue: 110 },
  { date: '2026-07-01', unitValue: 99 },
];
const position: PositionInput = { amount: 10_000, units: 100, unitCost: 100, investedAt: '2026-01-01', status: 'ACTIVE', redeemedAt: null, redeemedValue: null };

describe('Métricas de inversión', () => {
  it('valueAt devuelve el último valor vigente en la fecha', () => {
    expect(valueAt(series, '2025-12-31')).toBeNull();
    expect(valueAt(series, '2026-01-01')).toBe(100);
    expect(valueAt(series, '2026-05-15')).toBe(110);
    expect(valueAt(series, '2027-01-01')).toBe(99);
  });

  it('calcula valor, ganancia, rentabilidad y rendimiento anualizado', () => {
    const m = positionMetrics(position, series.slice(0, 2), '2026-04-01');
    expect(m).toMatchObject({ currentUnitValue: 110, currentValue: 11_000, pnl: 1_000, returnPct: 10, daysHeld: 90 });
    // (1.10)^(365/90) - 1 = 47.2 %
    expect(m.annualizedPct).toBeCloseTo(47.2, 0);
  });

  it('muestra pérdidas con signo negativo y no anualiza periodos menores a 30 días', () => {
    const loss = positionMetrics(position, series, '2026-07-01');
    expect(loss).toMatchObject({ currentValue: 9_900, pnl: -100, returnPct: -1 });
    const short = positionMetrics({ ...position, investedAt: '2026-06-20' }, series, '2026-07-01');
    expect(short.daysHeld).toBe(11);
    expect(short.annualizedPct).toBeNull();
  });

  it('una posición rescatada congela su resultado en lo rescatado', () => {
    const m = positionMetrics({ ...position, status: 'REDEEMED', redeemedAt: '2026-04-01', redeemedValue: 11_000 }, series, '2026-12-31');
    expect(m).toMatchObject({ currentValue: 11_000, pnl: 1_000, daysHeld: 90 });
  });

  it('reconstruye el historial del portafolio con el capital aportado', () => {
    const second: PositionInput & { opportunityId: string } = { ...position, opportunityId: 'b', amount: 5_000, units: 50, investedAt: '2026-04-01' };
    const history = portfolioHistory(
      [{ ...position, opportunityId: 'a' }, second],
      new Map([['a', series], ['b', [{ date: '2026-04-01', unitValue: 100 }, { date: '2026-07-01', unitValue: 120 }]]]),
      '2026-07-01',
    );
    expect(history.map((h) => h.date)).toEqual(['2026-01-01', '2026-04-01', '2026-07-01']);
    expect(history[0]).toEqual({ date: '2026-01-01', value: 10_000, invested: 10_000 });
    expect(history[1]).toEqual({ date: '2026-04-01', value: 16_000, invested: 15_000 }); // 100*110 + 50*100
    expect(history[2]).toEqual({ date: '2026-07-01', value: 15_900, invested: 15_000 }); // 100*99 + 50*120
  });

  it('estadísticas de cotización: variaciones, máximo y mínimo', () => {
    const stats = opportunityStats(series, '2026-07-01')!;
    expect(stats).toMatchObject({ latestValue: 99, previousValue: 110, change: -11, changePct: -10, high: 110, low: 99, inceptionDate: '2026-01-01' });
    expect(stats.sinceInceptionPct).toBe(-1);
    expect(stats.ytdPct).toBe(-1); // nació este año: base = valor inicial
    expect(stats.threeMonthPct).toBeCloseTo(-10, 0); // vs. 2026-04-02 -> 110
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });
});
