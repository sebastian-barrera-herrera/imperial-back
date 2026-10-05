import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { createApp, createStaff, login, registerClient } from './helpers';

type Agent = ReturnType<typeof request.agent>;
// Fechas relativas a "hoy" para que la prueba no dependa del calendario en que se ejecute.
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const TODAY = day(0);
const D0 = day(-270);
const D1 = day(-180);
const D2 = day(-90);

describe('Portafolio del inversionista', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let root: Agent;
  let lawyer: Agent;
  let alice: Agent;
  let bob: Agent;
  let aliceId: string;
  let opportunityId: string;
  let firstPositionId: string;
  let secondPositionId: string;

  const opportunity = { title: 'Fondo de recuperación I', summary: 'Participación en recuperaciones judiciales.', terms: 'Plazo fijo de 12 meses. Capital en riesgo.', minAmount: 1000, maxAmount: 100000, annualRate: 12, termMonths: 12, risk: 'MEDIUM' };

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await createStaff(prisma, 'root@example.com', Role.SUPERADMIN);
    await createStaff(prisma, 'abogado@example.com', Role.LAWYER);
    root = await login(app, 'root@example.com');
    lawyer = await login(app, 'abogado@example.com');
    const a = await registerClient(app, 'alice@example.com', 'Alice Inversionista');
    alice = a.agent;
    aliceId = a.user.id;
    bob = (await registerClient(app, 'bob@example.com', 'Bob Sin Inversiones')).agent;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('toda oportunidad nace con valor unitario inicial de 100 y los borradores no admiten inversiones', async () => {
    const draft = await root.post('/api/admin/investments/opportunities').send(opportunity).expect(201);
    opportunityId = draft.body.id;
    const valuations = await root.get(`/api/admin/investments/opportunities/${opportunityId}/valuations`).expect(200);
    expect(valuations.body).toEqual([{ id: expect.any(String), date: TODAY, unitValue: 100, note: 'Valor inicial' }]);

    await root.post('/api/admin/investments/positions').send({ userId: aliceId, opportunityId, amount: 5000 }).expect(400); // borrador
    await root.patch(`/api/admin/investments/opportunities/${opportunityId}`).send({ status: 'OPEN' }).expect(200);
  });

  it('valida valoraciones y posiciones, y exige rol de superadmin', async () => {
    const path = `/api/admin/investments/opportunities/${opportunityId}/valuations`;
    await root.post(path).send({ date: '2999-01-01', unitValue: 120 }).expect(400); // futura
    await root.post(path).send({ date: '2026-02-30', unitValue: 120 }).expect(400); // inexistente
    await root.post(path).send({ date: 'ayer', unitValue: 120 }).expect(400);
    await root.post(path).send({ date: TODAY, unitValue: 0 }).expect(400);
    await lawyer.post(path).send({ date: TODAY, unitValue: 120 }).expect(403);
    await alice.post(path).send({ date: TODAY, unitValue: 120 }).expect(403);

    // Serie histórica: 100 → 110 → 121 → 125 (hoy)
    await root.post(path).send({ date: D0, unitValue: 100, note: 'Inicio de año' }).expect(201);
    await root.post(path).send({ date: D1, unitValue: 110 }).expect(201);
    await root.post(path).send({ date: D2, unitValue: 121 }).expect(201);

    const body = { userId: aliceId, opportunityId };
    await root.post('/api/admin/investments/positions').send({ ...body, amount: 500 }).expect(400); // bajo el mínimo
    await root.post('/api/admin/investments/positions').send({ ...body, amount: 500000 }).expect(400); // sobre el máximo
    await root.post('/api/admin/investments/positions').send({ ...body, amount: 5000, investedAt: '2025-06-01' }).expect(400); // sin valoración previa
    await root.post('/api/admin/investments/positions').send({ ...body, amount: 5000, investedAt: '2999-01-01' }).expect(400);
    await root.post('/api/admin/investments/positions').send({ userId: 'no-existe', opportunityId, amount: 5000 }).expect(400);
    await lawyer.post('/api/admin/investments/positions').send({ ...body, amount: 5000 }).expect(403);
    await alice.post('/api/admin/investments/positions').send({ ...body, amount: 5000 }).expect(403);
    await alice.get('/api/admin/investments/positions').expect(403);
  });

  it('calcula unidades al valor de la fecha de compra y arma el portafolio con ganancias', async () => {
    const first = await root.post('/api/admin/investments/positions').send({ userId: aliceId, opportunityId, amount: 10000, investedAt: D0 }).expect(201);
    const second = await root.post('/api/admin/investments/positions').send({ userId: aliceId, opportunityId, amount: 5500, investedAt: D1 }).expect(201);
    firstPositionId = first.body.id;
    secondPositionId = second.body.id;
    expect(first.body).toMatchObject({ units: '100', unitCost: '100', amount: '10000' });
    expect(first.body.code).toMatch(/^INV-\d{4}-00001$/);
    expect(second.body).toMatchObject({ units: '50', unitCost: '110' });

    // Hoy el valor unitario sube a 125 (se corrige la valoración de hoy) → Alice recibe una alerta
    await root.post(`/api/admin/investments/opportunities/${opportunityId}/valuations`).send({ date: TODAY, unitValue: 125, note: 'Cierre del trimestre' }).expect(201);

    const portfolio = (await alice.get('/api/investments/portfolio').expect(200)).body;
    // 150 unidades × 125 = 18 750 sobre 15 500 aportados
    expect(portfolio.summary).toMatchObject({ activePositions: 2, invested: 15500, currentValue: 18750, unrealizedPnl: 3250, returnPct: 20.97, realizedPnl: 0 });
    expect(portfolio.summary.annualizedPct).toBeGreaterThan(20);
    // Último cambio: 125 vs 121 sobre 150 unidades = +600 (+3.31 %)
    expect(portfolio.summary.lastChange).toEqual({ amount: 600, pct: 3.31, asOf: TODAY });
    expect(portfolio.allocation).toEqual([{ opportunityId, title: opportunity.title, value: 18750, sharePct: 100 }]);
    expect(portfolio.history).toEqual([
      { date: D0, value: 10000, invested: 10000 },
      { date: D1, value: 16500, invested: 15500 },
      { date: D2, value: 18150, invested: 15500 },
      { date: TODAY, value: 18750, invested: 15500 },
    ]);
    const p1 = portfolio.positions.find((p: { id: string }) => p.id === firstPositionId);
    expect(p1).toMatchObject({ currentUnitValue: 125, currentValue: 12500, pnl: 2500, returnPct: 25, status: 'ACTIVE' });
    expect(p1.sparkline.length).toBeGreaterThan(2);

    const alerts = (await alice.get('/api/notifications').expect(200)).body.items as { title: string; body: string }[];
    expect(alerts.some((n) => n.title.startsWith('Inversión registrada: INV-'))).toBe(true);
    const valuationAlert = alerts.find((n) => n.title === `Nueva valoración: ${opportunity.title}`);
    expect(valuationAlert?.body).toContain('+3.31%');
  });

  it('cada cliente solo ve su propio portafolio', async () => {
    const empty = (await bob.get('/api/investments/portfolio').expect(200)).body;
    expect(empty.positions).toEqual([]);
    expect(empty.history).toEqual([]);
    expect(empty.summary).toMatchObject({ invested: 0, currentValue: 0, activePositions: 0, lastChange: null });
    const bobAlerts = (await bob.get('/api/notifications').expect(200)).body.items as { title: string }[];
    expect(bobAlerts.some((n) => n.title.startsWith('Nueva valoración'))).toBe(false);
    await request(app.getHttpServer()).get('/api/investments/portfolio').expect(401);
  });

  it('muestra el rendimiento tipo cotización y respeta la visibilidad de oportunidades cerradas', async () => {
    const perf = (await bob.get(`/api/investments/opportunities/${opportunityId}/performance`).expect(200)).body;
    expect(perf.series.map((s: { date: string }) => s.date)).toEqual([D0, D1, D2, TODAY]);
    expect(perf.stats).toMatchObject({ latestValue: 125, previousValue: 121, change: 4, high: 125, low: 100, sinceInceptionPct: 25, inceptionDate: D0 });

    const list = (await bob.get('/api/investments/opportunities').expect(200)).body;
    expect(list[0].quote).toMatchObject({ latestValue: 125, sinceInceptionPct: 25 });

    await root.patch(`/api/admin/investments/opportunities/${opportunityId}`).send({ status: 'CLOSED' }).expect(200);
    await bob.get(`/api/investments/opportunities/${opportunityId}/performance`).expect(404); // sin posición ya no la ve
    await alice.get(`/api/investments/opportunities/${opportunityId}/performance`).expect(200); // su inversionista sí
  });

  it('rescata una posición congelando su resultado y bloquea operaciones inválidas', async () => {
    await root.post(`/api/admin/investments/positions/${secondPositionId}/redeem`).send({ date: day(-200) }).expect(400); // antes de invertir
    const redeemed = await root.post(`/api/admin/investments/positions/${secondPositionId}/redeem`).send({}).expect(200);
    expect(redeemed.body).toMatchObject({ status: 'REDEEMED', redeemedValue: '6250' }); // 50 × 125
    await root.post(`/api/admin/investments/positions/${secondPositionId}/redeem`).send({}).expect(409);
    await alice.post(`/api/admin/investments/positions/${firstPositionId}/redeem`).send({}).expect(403);

    const portfolio = (await alice.get('/api/investments/portfolio').expect(200)).body;
    expect(portfolio.summary).toMatchObject({ activePositions: 1, invested: 10000, currentValue: 12500, unrealizedPnl: 2500, realizedPnl: 750 });
    const closed = portfolio.positions.find((p: { id: string }) => p.id === secondPositionId);
    expect(closed).toMatchObject({ status: 'REDEEMED', currentValue: 6250, pnl: 750 });
    const alerts = (await alice.get('/api/notifications').expect(200)).body.items as { title: string }[];
    expect(alerts.some((n) => n.title.startsWith('Inversión rescatada'))).toBe(true);
  });

  it('protege los datos: no se borra la valoración inicial ni oportunidades con inversiones; reportes y panel solo para superadmin', async () => {
    const vals = (await root.get(`/api/admin/investments/opportunities/${opportunityId}/valuations`).expect(200)).body as { id: string; date: string }[];
    const inception = vals.find((v) => v.date === D0)!;
    const middle = vals.find((v) => v.date === D2)!;
    await root.delete(`/api/admin/investments/opportunities/${opportunityId}/valuations/${inception.id}`).expect(409);
    await root.delete(`/api/admin/investments/opportunities/${opportunityId}/valuations/${middle.id}`).expect(200);
    await root.delete(`/api/admin/investments/opportunities/${opportunityId}`).expect(409);

    const summary = (await root.get('/api/admin/investments/summary').expect(200)).body;
    expect(summary).toMatchObject({ aum: 12500, invested: 10000, pnl: 2500, returnPct: 25, investors: 1, activePositions: 1 });
    expect((await root.get('/api/admin/stats').expect(200)).body.investments).toMatchObject({ aum: 12500 });
    expect((await lawyer.get('/api/admin/stats').expect(200)).body.investments).toBeNull();

    const list = (await root.get('/api/admin/investments/positions').query({ status: 'ACTIVE' }).expect(200)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ code: expect.stringMatching(/^INV-/), user: { email: 'alice@example.com' } });

    const csv = await root.get('/api/admin/reports/positions.csv').expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    await lawyer.get('/api/admin/reports/positions.csv').expect(403);
  });
});
