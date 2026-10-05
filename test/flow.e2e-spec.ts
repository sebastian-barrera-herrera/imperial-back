import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import * as http from 'http';
import request from 'supertest';
import { createApp, createStaff, fakePdf, login, registerClient } from './helpers';

type Agent = ReturnType<typeof request.agent>;

describe('Flujo del cliente: perfil → documentos → desembolso → seguimiento', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let root: Agent;
  let lawyer: Agent;
  let client: Agent;
  let clientId: string;

  const upload = (agent: Agent, category: string, buffer: Buffer = fakePdf(), filename = 'documento.pdf') =>
    agent.post('/api/documents').field('category', category).attach('file', buffer, { filename, contentType: 'application/pdf' });

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await createStaff(prisma, 'root@example.com', Role.SUPERADMIN, 'Super Admin');
    await createStaff(prisma, 'abogado@example.com', Role.LAWYER, 'Abogada Uno');
    await createStaff(prisma, 'abogado2@example.com', Role.LAWYER, 'Abogado Dos');
    root = await login(app, 'root@example.com');
    lawyer = await login(app, 'abogado@example.com');
    const registered = await registerClient(app, 'cliente@example.com', 'Carlos Cliente');
    client = registered.agent;
    clientId = registered.user.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('guarda cédula y cuenta cifradas en base de datos y solo expone la cuenta enmascarada', async () => {
    const res = await client
      .put('/api/profile')
      .send({ cedula: '1234567890', phone: '+57 300 123 4567', bankName: 'Bancolombia', accountType: 'SAVINGS', accountNumber: '123-456-789-012' })
      .expect(200);
    expect(res.body).toMatchObject({ cedula: '1234567890', accountNumberMasked: '••••9012', hasBankAccount: true });
    expect(JSON.stringify(res.body)).not.toContain('123-456-789-012');

    const row = await prisma.profile.findUniqueOrThrow({ where: { userId: clientId } });
    expect(row.cedulaEnc).toMatch(/^v1\./);
    expect(row.accountNumberEnc).toMatch(/^v1\./);
    expect(JSON.stringify(row)).not.toContain('1234567890');
    expect(JSON.stringify(row)).not.toContain('123-456-789-012');

    // La cédula es única entre cuentas.
    const other = await registerClient(app, 'otro@example.com');
    await other.agent.put('/api/profile').send({ cedula: '1234567890' }).expect(409);
    // Validación de formato.
    await client.put('/api/profile').send({ phone: 'abc' }).expect(400);
  });

  it('valida el archivo por su contenido real, evita duplicados y aísla documentos entre clientes', async () => {
    await upload(client, 'IDENTITY', Buffer.from('esto no es un pdf, solo texto plano'), 'falso.pdf').expect(400);
    await upload(client, 'IDENTITY', Buffer.alloc(11 * 1024 * 1024, 1), 'enorme.pdf').expect(413);

    const pdf = fakePdf();
    const ok = await upload(client, 'IDENTITY', pdf, 'cédula frente.pdf').expect(201);
    expect(ok.body).toMatchObject({ status: 'PENDING', category: 'IDENTITY', mimeType: 'application/pdf', originalName: 'cédula frente.pdf' });
    expect(ok.body.storageKey).toBeUndefined();
    await upload(client, 'IDENTITY', pdf, 'copia.pdf').expect(409);

    const stranger = await registerClient(app, 'intruso@example.com');
    await stranger.agent.get(`/api/documents/${ok.body.id}/download`).expect(404);
    await stranger.agent.delete(`/api/documents/${ok.body.id}`).expect(404);

    const download = await client.get(`/api/documents/${ok.body.id}/download`).buffer(true).expect(200);
    expect(download.headers['content-type']).toContain('application/pdf');
    expect(download.headers['content-disposition']).toContain("filename*=UTF-8''c%C3%A9dula%20frente.pdf");

    const list = await client.get('/api/documents').expect(200);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.summary.find((s: { category: string }) => s.category === 'IDENTITY')).toMatchObject({ total: 1, pending: 1 });
  });

  it('el personal valida/rechaza, el cliente recibe alertas y los validados no se pueden borrar', async () => {
    const identity = (await client.get('/api/documents').expect(200)).body.items[0];

    await lawyer.post(`/api/admin/documents/${identity.id}/reject`).send({}).expect(400);
    await lawyer.post(`/api/admin/documents/${identity.id}/reject`).send({ reason: 'Imagen borrosa' }).expect(200);
    let alerts = await client.get('/api/notifications').expect(200);
    expect(alerts.body.items[0]).toMatchObject({ type: 'DOCUMENT', title: 'Documento rechazado' });
    expect(alerts.body.items[0].body).toContain('Imagen borrosa');

    await lawyer.post(`/api/admin/documents/${identity.id}/validate`).expect(200);
    await lawyer.post(`/api/admin/documents/${identity.id}/validate`).expect(400);
    alerts = await client.get('/api/notifications').query({ unread: 'true' }).expect(200);
    expect(alerts.body.unread).toBeGreaterThanOrEqual(2);

    await client.delete(`/api/documents/${identity.id}`).expect(403);

    // El personal puede descargar y queda en la auditoría.
    await lawyer.get(`/api/admin/documents/${identity.id}`).expect(404); // no existe GET individual de admin
    await lawyer.get(`/api/documents/${identity.id}/download`).buffer(true).expect(200);
    const audit = await root.get('/api/admin/audit').query({ action: 'DOCUMENT_DOWNLOADED' }).expect(200);
    expect(audit.body.total).toBe(1);

    // Un rechazado sí se puede eliminar.
    const extra = await upload(client, 'RECEIPT').expect(201);
    await lawyer.post(`/api/admin/documents/${extra.body.id}/reject`).send({ reason: 'No corresponde' }).expect(200);
    await client.delete(`/api/documents/${extra.body.id}`).expect(200);
  });

  it('no permite solicitar un desembolso sin banco ni documentos validados', async () => {
    const fresh = await registerClient(app, 'sin-datos@example.com');
    const body = { amount: 1_500_000, concept: 'Recuperación de capital' };
    const noBank = await fresh.agent.post('/api/disbursements').send(body).expect(422);
    expect(noBank.body.message).toContain('datos bancarios');

    await client.post('/api/disbursements').send({ ...body, amount: -5 }).expect(400);
    const noBankDocs = await client.post('/api/disbursements').send(body).expect(422);
    expect(noBankDocs.body.message).toContain('bancarios');
  });

  let disbursementId: string;

  it('con documentos validados el cliente crea la solicitud y el personal la lleva hasta desembolsada', async () => {
    const bankDoc = await upload(client, 'BANKING', fakePdf(), 'certificado.pdf').expect(201);
    await root.post(`/api/admin/documents/${bankDoc.body.id}/validate`).expect(200);

    const created = await client.post('/api/disbursements').send({ amount: 2500000.5, concept: 'Recuperación de capital', documentIds: [bankDoc.body.id] }).expect(201);
    disbursementId = created.body.id;
    expect(created.body).toMatchObject({ status: 'PENDING', currency: 'USD', amount: '2500000.5', accountLast4: '9012', bankName: 'Bancolombia' });
    expect(created.body.code).toMatch(/^DES-\d{4}-00001$/);
    expect(created.body.documents).toHaveLength(1);
    expect(created.body.events).toHaveLength(1);

    // El personal recibe aviso de la nueva solicitud.
    const staffAlerts = await lawyer.get('/api/notifications').expect(200);
    expect(staffAlerts.body.items.some((n: { title: string }) => n.title === 'Nueva solicitud de desembolso')).toBe(true);

    await lawyer.patch(`/api/admin/disbursements/${disbursementId}/status`).send({ status: 'DISBURSED' }).expect(409);
    await lawyer.patch(`/api/admin/disbursements/${disbursementId}/status`).send({ status: 'REJECTED' }).expect(400);
    for (const status of ['APPROVED', 'IN_PROCESS', 'DISBURSED']) {
      await lawyer.patch(`/api/admin/disbursements/${disbursementId}/status`).send({ status, note: `Paso ${status}` }).expect(200);
    }
    await lawyer.patch(`/api/admin/disbursements/${disbursementId}/status`).send({ status: 'APPROVED' }).expect(409);

    const detail = await client.get(`/api/disbursements/${disbursementId}`).expect(200);
    expect(detail.body.status).toBe('DISBURSED');
    expect(detail.body.disbursedAt).not.toBeNull();
    expect(detail.body.events.map((e: { toStatus: string }) => e.toStatus)).toEqual(['PENDING', 'APPROVED', 'IN_PROCESS', 'DISBURSED']);

    const alerts = await client.get('/api/notifications').expect(200);
    expect(alerts.body.items.some((n: { title: string }) => n.title.includes('desembolsada'))).toBe(true);

    // Otro cliente no ve la solicitud; el cliente no puede cancelarla una vez avanzada.
    const stranger = await registerClient(app, 'curioso@example.com');
    await stranger.agent.get(`/api/disbursements/${disbursementId}`).expect(404);
    await client.post(`/api/disbursements/${disbursementId}/cancel`).expect(409);
  });

  it('permite cancelar solo solicitudes pendientes y exporta el historial en CSV', async () => {
    const created = await client.post('/api/disbursements').send({ amount: 100000, concept: 'Segundo desembolso' }).expect(201);
    expect(created.body.code).toMatch(/00002$/);
    const cancelled = await client.post(`/api/disbursements/${created.body.id}/cancel`).expect(200);
    expect(cancelled.body.status).toBe('CANCELLED');
    await lawyer.patch(`/api/admin/disbursements/${created.body.id}/status`).send({ status: 'APPROVED' }).expect(409);

    const csv = await client.get('/api/disbursements/export.csv').buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks).toString('utf8')));
    });
    expect(csv.headers['content-type']).toContain('text/csv');
    const text = csv.body as string;
    expect(text.charCodeAt(0)).toBe(0xfeff);
    expect(text).toContain('Desembolsada');
    expect(text).toContain('Cancelada');
  });

  it('gestiona casos con timeline, requisitos y aislamiento por abogado asignado', async () => {
    const lawyerUser = await prisma.user.findUniqueOrThrow({ where: { email: 'abogado@example.com' } });
    const created = await lawyer
      .post('/api/admin/cases')
      .send({
        clientId,
        title: 'Recuperación de inversión fallida',
        amountClaimed: 50000000,
        nextSteps: 'Reunir soportes de transferencia',
        requirements: [
          { label: 'Cédula de ciudadanía', category: 'IDENTITY' },
          { label: 'Contrato firmado', category: 'LEGAL' },
        ],
      })
      .expect(201);
    const caseId = created.body.id;
    expect(created.body.number).toMatch(/^CAS-\d{4}-00001$/);
    expect(created.body.lawyer.id).toBe(lawyerUser.id);
    const states = Object.fromEntries(created.body.requirements.map((r: { label: string; state: string }) => [r.label, r.state]));
    expect(states).toEqual({ 'Cédula de ciudadanía': 'VALIDATED', 'Contrato firmado': 'MISSING' });

    // Alertas al cliente: caso abierto + documentos que faltan.
    const alerts = (await client.get('/api/notifications').expect(200)).body.items as { title: string }[];
    expect(alerts.some((n) => n.title.startsWith('Se abrió tu caso'))).toBe(true);
    expect(alerts.some((n) => n.title.startsWith('Documentos requeridos'))).toBe(true);

    // Otro abogado no ve el caso; el superadmin sí; el cliente ve el suyo y otro cliente no.
    const lawyer2 = await login(app, 'abogado2@example.com');
    await lawyer2.get(`/api/admin/cases/${caseId}`).expect(404);
    await lawyer2.patch(`/api/admin/cases/${caseId}`).send({ stage: 'NEGOTIATION' }).expect(404);
    expect((await lawyer2.get('/api/admin/cases').expect(200)).body.total).toBe(0);
    await root.get(`/api/admin/cases/${caseId}`).expect(200);
    // Solo el superadmin reasigna.
    const lawyer2User = await prisma.user.findUniqueOrThrow({ where: { email: 'abogado2@example.com' } });
    await lawyer.patch(`/api/admin/cases/${caseId}`).send({ lawyerId: lawyer2User.id }).expect(403);

    const updated = await lawyer.patch(`/api/admin/cases/${caseId}`).send({ stage: 'LEGAL_ANALYSIS', status: 'IN_PROGRESS', nextSteps: 'Audiencia de conciliación' }).expect(200);
    expect(updated.body.stage).toBe('LEGAL_ANALYSIS');
    expect(updated.body.events.map((e: { title: string }) => e.title)).toEqual(['Caso abierto', 'Etapa: Análisis jurídico']);
    await lawyer.post(`/api/admin/cases/${caseId}/events`).send({ title: 'Se radicó la demanda' }).expect(201);

    const own = await client.get(`/api/cases/${caseId}`).expect(200);
    expect(own.body.events).toHaveLength(3);
    expect(own.body.nextSteps).toBe('Audiencia de conciliación');
    const list = await client.get('/api/cases').expect(200);
    expect(list.body[0]).toMatchObject({ number: created.body.number, progress: 33 });

    const stranger = await registerClient(app, 'tercero@example.com');
    await stranger.agent.get(`/api/cases/${caseId}`).expect(404);

    // Cerrar el caso cierra etapa y estado a la vez.
    const closed = await lawyer.patch(`/api/admin/cases/${caseId}`).send({ status: 'CLOSED' }).expect(200);
    expect(closed.body).toMatchObject({ status: 'CLOSED', stage: 'CLOSED' });
  });

  it('simula inversiones, valida montos y limita la gestión de oportunidades al superadmin', async () => {
    const sim = await client.post('/api/investments/simulate').send({ principal: 1000000, annualRate: 12, termMonths: 12, mode: 'COMPOUND' }).expect(200);
    expect(sim.body.finalAmount).toBeCloseTo(1126825.03, 1);
    expect(sim.body.schedule).toHaveLength(12);
    const simple = await client.post('/api/investments/simulate').send({ principal: 1000000, annualRate: 12, termMonths: 12, mode: 'SIMPLE' }).expect(200);
    expect(simple.body.finalAmount).toBe(1120000);
    await client.post('/api/investments/simulate').send({ principal: 1000000, annualRate: 12, termMonths: 999, mode: 'COMPOUND' }).expect(400);

    const payload = { title: 'Fondo de recuperación I', summary: 'Participación en recuperaciones judiciales.', terms: 'Plazo fijo de 12 meses. Capital en riesgo.', minAmount: 5000000, maxAmount: 100000000, annualRate: 14.5, termMonths: 12, risk: 'MEDIUM' };
    await lawyer.post('/api/admin/investments/opportunities').send(payload).expect(403);
    await client.post('/api/admin/investments/opportunities').send(payload).expect(403);
    const draft = await root.post('/api/admin/investments/opportunities').send(payload).expect(201);
    expect((await client.get('/api/investments/opportunities').expect(200)).body).toHaveLength(0);

    await root.patch(`/api/admin/investments/opportunities/${draft.body.id}`).send({ status: 'OPEN' }).expect(200);
    const open = (await client.get('/api/investments/opportunities').expect(200)).body;
    expect(open).toHaveLength(1);
    const alerts = (await client.get('/api/notifications').expect(200)).body.items as { title: string }[];
    expect(alerts.some((n) => n.title === 'Nueva oportunidad de capital')).toBe(true);

    await client.post(`/api/investments/opportunities/${draft.body.id}/interest`).send({ amount: 1000 }).expect(400);
    await client.post(`/api/investments/opportunities/${draft.body.id}/interest`).send({ amount: 10000000, message: 'Me interesa' }).expect(201);
    await client.post(`/api/investments/opportunities/${draft.body.id}/interest`).send({ amount: 10000000 }).expect(409);
    await root.delete(`/api/admin/investments/opportunities/${draft.body.id}`).expect(409);
    const interests = await root.get('/api/admin/investments/interests').expect(200);
    expect(interests.body[0]).toMatchObject({ status: 'PENDING', user: { email: 'cliente@example.com' } });
  });

  it('respeta las preferencias de alertas y permite al superadmin enviar alertas manuales', async () => {
    await client.put('/api/notifications/preferences').send({ opportunities: false }).expect(200);
    const before = (await client.get('/api/notifications').expect(200)).body.total;
    await root.post('/api/admin/notifications').send({ audience: 'ALL_CLIENTS', type: 'OPPORTUNITY', title: 'Promoción muteada' }).expect(201);
    await root.post('/api/admin/notifications').send({ audience: 'USER', userId: clientId, type: 'SYSTEM', title: 'Mantenimiento programado' }).expect(201);
    const after = (await client.get('/api/notifications').expect(200)).body;
    expect(after.total).toBe(before + 1);
    expect(after.items[0].title).toBe('Mantenimiento programado');
    await lawyer.post('/api/admin/notifications').send({ audience: 'ALL_CLIENTS', type: 'SYSTEM', title: 'Masivo' }).expect(403);

    const first = after.items[0];
    await client.post(`/api/notifications/${first.id}/read`).expect(200);
    await client.post('/api/notifications/read-all').expect(200);
    expect((await client.get('/api/notifications/unread-count').expect(200)).body.unread).toBe(0);
    await client.delete(`/api/notifications/${first.id}`).expect(200);
  });

  it('entrega alertas en tiempo real por SSE', async () => {
    const server = app.getHttpServer().listen(0);
    const { port } = server.address() as { port: number };
    const cookie = await (async () => {
      const res = await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'cliente@example.com', password: 'Password12345' }).expect(200);
      return (res.headers['set-cookie'] as unknown as string[]).map((c) => c.split(';')[0]).join('; ');
    })();

    const received = new Promise<string>((resolve, reject) => {
      const req = http.get({ port, path: '/api/notifications/stream', headers: { cookie, accept: 'text/event-stream' } }, (res) => {
        expect(res.headers['content-type']).toContain('text/event-stream');
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString();
          if (buffer.includes('event: notification')) {
            req.destroy();
            resolve(buffer);
          }
        });
      });
      req.on('error', (e) => (e as NodeJS.ErrnoException).code === 'ECONNRESET' ? undefined : reject(e));
      setTimeout(() => {
        // Cuando la conexión está abierta, el personal envía una alerta.
        root.post('/api/admin/notifications').send({ audience: 'USER', userId: clientId, type: 'SYSTEM', title: 'Alerta en vivo' }).end(() => undefined);
      }, 500);
    });

    const payload = await received;
    expect(payload).toContain('Alerta en vivo');
    server.close();
  });
});
