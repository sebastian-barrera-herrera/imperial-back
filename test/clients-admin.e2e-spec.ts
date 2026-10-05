import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { PASSWORD, createApp, createStaff, login, registerClient } from './helpers';

type Agent = ReturnType<typeof request.agent>;
const today = (offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

describe('Gestión de clientes: asesor, depósitos, baja de acceso y país', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let root: Agent;
  let lawyer: Agent;
  let lawyerId: string;
  let carlos: Agent;
  let carlosId: string;
  let otra: Agent;
  let otraId: string;
  const anon = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await createStaff(prisma, 'root@example.com', Role.SUPERADMIN, 'Super Admin');
    lawyerId = (await createStaff(prisma, 'abogado@example.com', Role.LAWYER, 'Abogada Uno')).id;
    root = await login(app, 'root@example.com');
    lawyer = await login(app, 'abogado@example.com');
    const a = await registerClient(app, 'carlos@example.com', 'Carlos Cliente');
    carlos = a.agent; carlosId = a.user.id;
    const b = await registerClient(app, 'otra@example.com', 'Otra Cliente');
    otra = b.agent; otraId = b.user.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('solo el superadmin gestiona estos datos', async () => {
    for (const [method, url] of [['post', `/api/admin/clients/${carlosId}/deactivate`], ['post', `/api/admin/clients/${carlosId}/reactivate`], ['patch', `/api/admin/clients/${carlosId}/advisor`], ['get', `/api/admin/clients/${carlosId}/deposits`], ['post', `/api/admin/clients/${carlosId}/deposits`]] as const) {
      await anon()[method](url).expect(401);
      await carlos[method](url).expect(403);
      await lawyer[method](url).expect(403);
    }
    await lawyer.patch('/api/admin/deposits/x').expect(403);
    await carlos.delete('/api/admin/deposits/x').expect(403);
    // Y el cliente solo usa sus propias rutas
    await root.get('/api/advisor').expect(403);
    await root.get('/api/deposits').expect(403);
  });

  describe('asesor profesional', () => {
    it('el cliente no tiene asesor hasta que el superadmin se lo asigna', async () => {
      expect((await carlos.get('/api/advisor').expect(200)).body).toEqual({});
    });

    it('solo se asigna un abogado o superadmin activo y el cliente recibe una alerta', async () => {
      await root.patch(`/api/admin/clients/${carlosId}/advisor`).send({ advisorId: otraId }).expect(400); // un cliente no puede ser asesor
      await root.patch(`/api/admin/clients/${carlosId}/advisor`).send({ advisorId: 'no-existe' }).expect(400);
      await root.patch(`/api/admin/clients/${lawyerId}/advisor`).send({ advisorId: lawyerId }).expect(404); // el destinatario debe ser cliente
      await root.patch(`/api/admin/clients/${carlosId}/advisor`).send({ advisorId: lawyerId, extra: 1 }).expect(400);

      const res = await root.patch(`/api/admin/clients/${carlosId}/advisor`).send({ advisorId: lawyerId }).expect(200);
      expect(res.body.advisor).toEqual({ id: lawyerId, fullName: 'Abogada Uno' });
      expect((await carlos.get('/api/advisor').expect(200)).body).toEqual({ name: 'Abogada Uno', source: 'assigned' });
      const alert = (await carlos.get('/api/notifications').expect(200)).body.items.find((n: { title: string }) => n.title === 'Tu asesor profesional');
      expect(alert).toMatchObject({ type: 'SYSTEM', body: expect.stringContaining('Abogada Uno') });
      expect((await otra.get('/api/advisor').expect(200)).body).toEqual({}); // los demás clientes no se ven afectados
    });

    it('sin asesor asignado se muestra el abogado de su caso abierto; el asesor asignado tiene prioridad', async () => {
      await root.patch(`/api/admin/clients/${carlosId}/advisor`).send({ advisorId: null }).expect(200);
      expect((await carlos.get('/api/advisor').expect(200)).body).toEqual({});
      const other = await createStaff(prisma, 'abogado2@example.com', Role.LAWYER, 'Abogado Dos');
      await prisma.case.create({ data: { number: 'CAS-T1', clientId: carlosId, lawyerId: other.id, title: 'Recuperación de saldo' } });
      expect((await carlos.get('/api/advisor').expect(200)).body).toEqual({ name: 'Abogado Dos', source: 'case' });
      await root.patch(`/api/admin/clients/${carlosId}/advisor`).send({ advisorId: lawyerId }).expect(200);
      expect((await carlos.get('/api/advisor').expect(200)).body).toEqual({ name: 'Abogada Uno', source: 'assigned' });
    });
  });

  describe('depósitos', () => {
    let first: string;
    let second: string;

    it('se validan monto, fecha y destinatario', async () => {
      const url = `/api/admin/clients/${carlosId}/deposits`;
      for (const body of [{ amount: 0, depositedAt: today() }, { amount: -5, depositedAt: today() }, { amount: 10.123, depositedAt: today() }, { amount: '10', depositedAt: today() }, { depositedAt: today() },
        { amount: 10, depositedAt: today(2) }, { amount: 10, depositedAt: '2026-02-30' }, { amount: 10, depositedAt: 'ayer' }, { amount: 10, depositedAt: today(), extra: true }]) {
        await root.post(url).send(body).expect(400);
      }
      await root.post(`/api/admin/clients/no-existe/deposits`).send({ amount: 10, depositedAt: today() }).expect(404);
      await root.post(`/api/admin/clients/${lawyerId}/deposits`).send({ amount: 10, depositedAt: today() }).expect(404); // solo clientes
    });

    it('el superadmin registra depósitos y el cliente ve su total y su historial (solo lo suyo)', async () => {
      const a = await root.post(`/api/admin/clients/${carlosId}/deposits`).send({ amount: 2500, depositedAt: today(-10), reference: 'TRF-001', note: 'Primer depósito' }).expect(201);
      first = a.body.id;
      expect(a.body).toMatchObject({ amount: '2500.00', currency: 'USD', depositedAt: today(-10), reference: 'TRF-001', note: 'Primer depósito' });
      second = (await root.post(`/api/admin/clients/${carlosId}/deposits`).send({ amount: 1000.5, depositedAt: today(-2) }).expect(201)).body.id;

      const mine = (await carlos.get('/api/deposits').expect(200)).body;
      expect(mine).toMatchObject({ currency: 'USD', total: '3500.50' });
      expect(mine.items.map((d: { id: string }) => d.id)).toEqual([second, first]); // más reciente primero
      expect(JSON.stringify(mine)).not.toContain('root@example.com'); // no se expone quién lo registró
      expect((await otra.get('/api/deposits').expect(200)).body).toMatchObject({ total: '0.00', items: [] });

      const alert = (await carlos.get('/api/notifications').expect(200)).body.items.find((n: { title: string }) => n.title === 'Depósito registrado');
      expect(alert).toMatchObject({ type: 'SYSTEM', link: '/dashboard/depositos' });
      expect(alert.body).toContain('$');
      const admin = (await root.get(`/api/admin/clients/${carlosId}/deposits`).expect(200)).body;
      expect(admin).toMatchObject({ client: { id: carlosId, fullName: 'Carlos Cliente' }, total: '3500.50' });
    });

    it('se pueden corregir y eliminar, y todo queda auditado con los valores anteriores', async () => {
      const upd = await root.patch(`/api/admin/deposits/${second}`).send({ amount: 1200, reference: 'TRF-002' }).expect(200);
      expect(upd.body).toMatchObject({ amount: '1200.00', reference: 'TRF-002' });
      await root.patch(`/api/admin/deposits/${second}`).send({ depositedAt: today(3) }).expect(400);
      await root.patch('/api/admin/deposits/no-existe').send({ amount: 5 }).expect(404);
      expect((await carlos.get('/api/deposits').expect(200)).body.total).toBe('3700.00');

      await root.delete(`/api/admin/deposits/${first}`).expect(200);
      await root.delete(`/api/admin/deposits/${first}`).expect(404);
      expect((await carlos.get('/api/deposits').expect(200)).body.total).toBe('1200.00');

      const logs = await prisma.auditLog.findMany({ where: { entity: 'ClientDeposit' } });
      expect(new Set(logs.map((l) => l.action))).toEqual(new Set(['DEPOSIT_CREATED', 'DEPOSIT_UPDATED', 'DEPOSIT_DELETED']));
      expect(logs.find((l) => l.action === 'DEPOSIT_UPDATED')!.metadata).toMatchObject({ before: { amount: '1000.50' }, after: { amount: '1200.00' } });
      expect(logs.find((l) => l.action === 'DEPOSIT_DELETED')!.metadata).toMatchObject({ amount: '2500.00', reference: 'TRF-001' });
    });
  });

  describe('país y lista de clientes', () => {
    it('el cliente indica su país y el personal ve la lista con sus datos (asesor, depósitos, país)', async () => {
      const res = await carlos.put('/api/profile').send({ country: 'Perú', phone: '+51 999 888 777' }).expect(200);
      expect(res.body.country).toBe('Perú');
      const list = (await lawyer.get('/api/admin/clients').expect(200)).body.items;
      const row = list.find((c: { id: string }) => c.id === carlosId);
      expect(row).toMatchObject({ fullName: 'Carlos Cliente', country: 'Perú', phone: '+51 999 888 777', status: 'ACTIVE', depositTotal: '1200.00', advisor: { id: lawyerId, fullName: 'Abogada Uno' }, deactivatedAt: null });
      expect(list.find((c: { id: string }) => c.id === otraId)).toMatchObject({ depositTotal: '0.00', advisor: null, country: null });
      const detail = (await root.get(`/api/admin/clients/${carlosId}`).expect(200)).body;
      expect(detail).toMatchObject({ country: 'Perú', advisor: { fullName: 'Abogada Uno' } });
    });
  });

  describe('baja y reactivación', () => {
    it('al dar de baja a un cliente pierde el acceso al instante, pero se conservan sus datos', async () => {
      await carlos.get('/api/profile').expect(200);
      const url = `/api/admin/clients/${otraId}/deactivate`;
      await root.post(url).send({}).expect(400);
      await root.post(url).send({ reason: 'ab' }).expect(400);
      await root.post(`/api/admin/clients/${lawyerId}/deactivate`).send({ reason: 'Prueba de personal' }).expect(404); // solo clientes

      const res = await root.post(`/api/admin/clients/${carlosId}/deactivate`).send({ reason: 'Solicitó cerrar su cuenta' }).expect(200);
      expect(res.body).toMatchObject({ status: 'SUSPENDED', deactivationReason: 'Solicitó cerrar su cuenta' });
      await root.post(`/api/admin/clients/${carlosId}/deactivate`).send({ reason: 'Otra vez' }).expect(409);

      // La sesión que ya tenía abierta deja de funcionar de inmediato.
      await carlos.get('/api/profile').expect(401);
      await carlos.get('/api/deposits').expect(401);
      const refresh = await carlos.post('/api/auth/refresh').expect(401);
      expect(refresh.body.message).toBeTruthy();

      // Al intentar entrar recibe un mensaje claro (solo si acierta la contraseña); con una incorrecta no se revela nada.
      const blocked = await anon().post('/api/auth/login').send({ email: 'carlos@example.com', password: PASSWORD }).expect(403);
      expect(blocked.body.message).toContain('desactivado');
      const wrong = await anon().post('/api/auth/login').send({ email: 'carlos@example.com', password: 'Incorrecta123' }).expect(401);
      expect(wrong.body.message).toBe('Correo o contraseña incorrectos');

      // Sus datos siguen ahí y el personal los ve con el motivo de la baja.
      const dep = (await root.get(`/api/admin/clients/${carlosId}/deposits`).expect(200)).body;
      expect(dep.total).toBe('1200.00');
      const suspended = (await lawyer.get('/api/admin/clients?status=SUSPENDED').expect(200)).body.items;
      expect(suspended.map((c: { id: string }) => c.id)).toEqual([carlosId]);
      expect(suspended[0]).toMatchObject({ status: 'SUSPENDED', deactivationReason: 'Solicitó cerrar su cuenta', deactivatedAt: expect.any(String) });
      expect((await lawyer.get('/api/admin/clients?status=ACTIVE').expect(200)).body.items.map((c: { id: string }) => c.id)).toEqual([otraId]);
      expect(await prisma.refreshToken.count({ where: { userId: carlosId, revokedAt: null } })).toBe(0);
    });

    it('reactivar devuelve el acceso; ambas acciones quedan auditadas', async () => {
      await root.post(`/api/admin/clients/${otraId}/reactivate`).expect(409); // ya tiene acceso
      const res = await root.post(`/api/admin/clients/${carlosId}/reactivate`).expect(200);
      expect(res.body).toMatchObject({ status: 'ACTIVE', deactivatedAt: null, deactivationReason: null });
      const back = await login(app, 'carlos@example.com');
      await back.get('/api/profile').expect(200);
      expect((await back.get('/api/deposits').expect(200)).body.total).toBe('1200.00');
      await root.post(`/api/admin/clients/${carlosId}/reactivate`).expect(409);

      const actions = new Set((await prisma.auditLog.findMany({ where: { entity: 'User' } })).map((a) => a.action));
      for (const a of ['CLIENT_DEACTIVATED', 'CLIENT_REACTIVATED', 'LOGIN_BLOCKED', 'CLIENT_ADVISOR_SET']) expect(actions).toContain(a);
    });
  });
});
