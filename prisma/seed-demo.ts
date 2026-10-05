import 'dotenv/config'; // carga .env aunque se haya creado después de `npm install`
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

/**
 * Datos de DEMOSTRACIÓN para desarrollo: un cliente inversionista con tres oportunidades, un año de valoraciones
 * simuladas y tres posiciones. NO usar en producción (el script se niega a correr). Las cifras son inventadas.
 * Uso: npm run seed:demo
 */
if (process.env.NODE_ENV === 'production') {
  console.error('seed:demo no se ejecuta con NODE_ENV=production.');
  process.exit(1);
}

const prisma = new PrismaClient();
const DEMO_EMAIL = 'cliente.demo@imperial.test';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'DemoCliente2026';
const DAY = 86_400_000;
const dayKey = (d: Date) => d.toISOString().slice(0, 10);
const parseDay = (s: string) => new Date(`${s}T00:00:00.000Z`);
const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

// PRNG determinista: el demo se ve igual en cada máquina.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FUNDS = [
  { title: 'Fondo de Recuperación I (demo)', summary: 'Participación en recuperaciones judiciales de créditos comerciales. Datos de demostración.', drift: 0.011, vol: 0.006, risk: 'MEDIUM' as const, rate: 13.5, months: 18, min: 5000, seed: 11 },
  { title: 'Fondo Conservador (demo)', summary: 'Cartera de menor volatilidad con acuerdos de pago pactados. Datos de demostración.', drift: 0.006, vol: 0.002, risk: 'LOW' as const, rate: 8, months: 12, min: 1000, seed: 22 },
  { title: 'Fondo Oportunista (demo)', summary: 'Casos de mayor riesgo y potencial de recuperación. Datos de demostración.', drift: 0.009, vol: 0.03, risk: 'HIGH' as const, rate: 18, months: 24, min: 10000, seed: 33 },
];

async function main() {
  if (await prisma.user.findUnique({ where: { email: DEMO_EMAIL } })) {
    console.log('Los datos demo ya existen. Para empezar de cero, usa una base nueva.');
    return;
  }
  const now = Date.now();
  const today = dayKey(new Date(now));

  const client = await prisma.user.create({
    data: {
      email: DEMO_EMAIL, fullName: 'Camila Demo', role: Role.CLIENT, passwordHash: await bcrypt.hash(DEMO_PASSWORD, 12),
      privacyAcceptedAt: new Date(), privacyVersion: '2026-10-05', profile: { create: {} }, preference: { create: {} },
    },
  });

  const opportunities: { id: string; series: { date: string; value: number }[] }[] = [];
  for (const f of FUNDS) {
    const random = mulberry32(f.seed);
    const opp = await prisma.investmentOpportunity.create({
      data: { title: f.title, summary: f.summary, terms: 'Datos de demostración para desarrollo. No representan un producto real.', minAmount: f.min, annualRate: f.rate, termMonths: f.months, risk: f.risk, status: 'OPEN' },
    });
    const series: { date: string; value: number }[] = [];
    let value = 100;
    // Una valoración cada 30 días durante ~11 meses, más el valor de hoy.
    for (let back = 330; back >= 0; back -= 30) {
      if (back < 330) value *= 1 + f.drift + (random() - 0.5) * 2 * f.vol;
      series.push({ date: dayKey(new Date(now - back * DAY)), value: round(value, 4) });
    }
    if (series[series.length - 1].date !== today) series.push({ date: today, value: round(value * (1 + (random() - 0.4) * f.vol), 4) });
    await prisma.opportunityValuation.createMany({ data: series.map((s, i) => ({ opportunityId: opp.id, date: parseDay(s.date), unitValue: s.value, note: i === 0 ? 'Valor inicial (demo)' : null })) });
    opportunities.push({ id: opp.id, series });
  }

  const positions = [
    { fund: 0, amount: 12000, back: 300 },
    { fund: 1, amount: 8000, back: 210 },
    { fund: 2, amount: 6500, back: 120 },
    { fund: 0, amount: 4000, back: 60 },
  ];
  let n = 0;
  for (const p of positions) {
    const { id, series } = opportunities[p.fund];
    const day = dayKey(new Date(now - p.back * DAY));
    const unitCost = [...series].reverse().find((s) => s.date <= day)!.value;
    n++;
    await prisma.investment.create({
      data: { code: `INV-DEMO-${String(n).padStart(3, '0')}`, userId: client.id, opportunityId: id, amount: p.amount, units: round(p.amount / unitCost, 6), unitCost, investedAt: parseDay(day) },
    });
  }
  console.log(`Demo listo. Cliente: ${DEMO_EMAIL} / ${DEMO_PASSWORD}  ·  ${FUNDS.length} oportunidades, ${positions.length} posiciones.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
