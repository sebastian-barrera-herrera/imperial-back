import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { spawnSync } from 'child_process';
import { copyFileSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import request from 'supertest';
import { verificationCode } from '../src/disbursements/verification';
import { createApp, createStaff, fakePdf, login, registerClient } from './helpers';

type Agent = ReturnType<typeof request.agent>;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const pdfToText = (buffer: Buffer): string | null => {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'pdf-')), 'a.pdf');
  writeFileSync(file, buffer);
  const out = spawnSync('pdftotext', ['-raw', file, '-'], { encoding: 'utf8' });
  return out.status === 0 ? out.stdout : null; // sin poppler instalado la prueba omite la comprobación de texto
};

describe('Documento de aprobación (PDF) y documentos del despacho', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let root: Agent;
  let lawyer: Agent;
  let client: Agent;
  let stranger: Agent;
  let clientId: string;
  let strangerId: string;
  let requestId: string;
  const anon = () => request(app.getHttpServer());
  const binary = (agent: Agent, url: string) => agent.get(url).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await createStaff(prisma, 'root@example.com', Role.SUPERADMIN, 'Super Admin');
    await createStaff(prisma, 'abogado@example.com', Role.LAWYER, 'Abogada Uno');
    root = await login(app, 'root@example.com');
    lawyer = await login(app, 'abogado@example.com');
    const a = await registerClient(app, 'cliente@example.com', 'Carlos Cliente Pérez');
    client = a.agent;
    clientId = a.user.id;
    const b = await registerClient(app, 'intruso@example.com', 'Intruso Ajeno');
    stranger = b.agent;
    strangerId = b.user.id;
    await client.put('/api/profile').send({ cedula: '1234567890', bankName: 'Bancolombia', accountType: 'SAVINGS', accountNumber: '123-456-789-012' }).expect(200);
    const created = await prisma.disbursementRequest.create({
      data: { code: 'DES-000001', clientId, amount: 12500.5, currency: 'USD', concept: 'Recuperación de saldo «Fondo I»', bankName: 'Bancolombia', accountLast4: '9012', events: { create: { toStatus: 'PENDING', note: 'Solicitud creada', actorName: 'Carlos Cliente Pérez' } } },
    });
    requestId = created.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  // ───────────── PDF de aprobación ─────────────
  describe('PDF de aprobación', () => {
    it('no existe mientras la solicitud no esté aprobada', async () => {
      await client.get(`/api/disbursements/${requestId}/approval-pdf`).expect(409);
      await lawyer.get(`/api/admin/disbursements/${requestId}/approval-pdf`).expect(409);
    });

    it('el cliente dueño descarga un PDF real; otros usuarios y visitantes no', async () => {
      await lawyer.patch(`/api/admin/disbursements/${requestId}/status`).send({ status: 'APPROVED', note: 'Documentación completa y verificada' }).expect(200);

      const res = await binary(client, `/api/disbursements/${requestId}/approval-pdf`).expect(200);
      expect(res.headers['content-type']).toContain('application/pdf');
      expect(res.headers['content-disposition']).toContain('attachment; filename="Aprobacion-DES-000001.pdf"');
      const pdf = res.body as Buffer;
      expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
      expect(pdf.length).toBeGreaterThan(20_000); // logo, marca de agua y QR incrustados
      expect(pdf.subarray(-6).toString()).toContain('%%EOF');

      if (process.env.SAVE_PDF) copyFileSync(writeTemp(pdf), process.env.SAVE_PDF);
      const text = pdfToText(pdf)?.replace(/\s+/g, ' ') ?? null;
      if (text) {
        for (const expected of ['DOCUMENTO DE APROBACIÓN DE DESEMBOLSO', 'DES-000001', 'Carlos Cliente Pérez', 'USD 12,500.50', 'DOCE MIL QUINIENTOS DÓLARES DE LOS ESTADOS UNIDOS DE AMÉRICA CON 50/100', 'Bancolombia', '9012', '7890', 'Página 1 de 1', 'Verificación']) {
          expect(text).toContain(expected);
        }
        expect(text).not.toContain('1234567890'); // la cédula completa nunca se imprime
        expect(text).not.toContain('123-456-789-012');
      }

      await stranger.get(`/api/disbursements/${requestId}/approval-pdf`).expect(404);
      await anon().get(`/api/disbursements/${requestId}/approval-pdf`).expect(401);

      const staff = await binary(lawyer, `/api/admin/disbursements/${requestId}/approval-pdf`).expect(200);
      expect((staff.body as Buffer).subarray(0, 5).toString()).toBe('%PDF-');
      const audit = await prisma.auditLog.findFirst({ where: { action: 'DISBURSEMENT_APPROVAL_PDF_DOWNLOADED' } });
      expect(audit).toMatchObject({ entityId: requestId, actorEmail: 'abogado@example.com' });

    });

    it('la verificación pública confirma el documento sin revelar datos personales y rechaza códigos falsos', async () => {
      const row = await prisma.disbursementRequest.findUniqueOrThrow({ where: { id: requestId }, include: { events: true } });
      const approvedAt = row.events.find((e) => e.toStatus === 'APPROVED')!.createdAt;
      const code = verificationCode(process.env.JWT_SECRET!, { reference: 'DES-000001', amount: '12500.50', currency: 'USD', approvedAt, clientId });
      expect(code).toMatch(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/);

      const ok = await anon().get('/api/public/verify').query({ ref: 'DES-000001', code }).expect(200);
      expect(ok.body).toMatchObject({ valid: true, reference: 'DES-000001', status: 'Aprobada', amount: '12500.50', currency: 'USD', beneficiary: 'C. C. P.' });
      expect(JSON.stringify(ok.body)).not.toContain('Carlos');
      expect(JSON.stringify(ok.body)).not.toContain('example.com');
      await anon().get('/api/public/verify').query({ ref: 'des-000001', code: code.toLowerCase() }).expect(200).expect((r) => expect(r.body.valid).toBe(true));

      for (const query of [{ ref: 'DES-000001', code: 'AAAA-BBBB-CCCC-DDDD' }, { ref: 'DES-999999', code }, { ref: 'DES-000001', code: code.replace(/.$/, code.endsWith('0') ? '1' : '0') }]) {
        const bad = await anon().get('/api/public/verify').query(query).expect(200);
        expect(bad.body).toEqual({ valid: false });
      }
      await anon().get('/api/public/verify').expect(400);
    });

    it('si la solicitud se rechaza después, el documento deja de ser válido', async () => {
      await lawyer.patch(`/api/admin/disbursements/${requestId}/status`).send({ status: 'REJECTED', note: 'Se detectó una inconsistencia' }).expect(200);
      const row = await prisma.disbursementRequest.findUniqueOrThrow({ where: { id: requestId }, include: { events: true } });
      const approvedAt = row.events.find((e) => e.toStatus === 'APPROVED')!.createdAt;
      const code = verificationCode(process.env.JWT_SECRET!, { reference: 'DES-000001', amount: '12500.50', currency: 'USD', approvedAt, clientId });
      const res = await anon().get('/api/public/verify').query({ ref: 'DES-000001', code }).expect(200);
      expect(res.body).toEqual({ valid: false });
      await client.get(`/api/disbursements/${requestId}/approval-pdf`).expect(409);
    });
  });

  // ───────────── Documentos del despacho ─────────────
  describe('documentos que el despacho entrega al cliente', () => {
    let docId: string;
    const send = (agent: Agent, id: string, over: Record<string, string> = {}, file: Buffer = fakePdf(), filename = 'contrato.pdf') =>
      agent.post(`/api/admin/clients/${id}/issued-documents`).field('title', over.title ?? 'Contrato de servicios').field('category', over.category ?? 'CONTRACT')
        .field('description', over.description ?? 'Versión firmada').attach('file', file, { filename, contentType: 'application/pdf' });

    it('solo el superadmin entrega documentos; el archivo se valida por su contenido', async () => {
      await send(lawyer, clientId).expect(403);
      await send(client, clientId).expect(403);
      await anon().post(`/api/admin/clients/${clientId}/issued-documents`).expect(401);
      await send(root, clientId, {}, Buffer.from('no soy un pdf, solo texto plano para probar'), 'falso.pdf').expect(400);
      await send(root, clientId, { category: 'NOPE' }).expect(400);
      await send(root, clientId, { title: 'ab' }).expect(400);
      await send(root, 'no-existe').expect(404);
      await send(root, (await prisma.user.findFirstOrThrow({ where: { role: Role.SUPERADMIN } })).id).expect(404); // solo a clientes
      await root.post(`/api/admin/clients/${clientId}/issued-documents`).field('title', 'Sin archivo').field('category', 'OTHER').expect(400);
      await send(root, clientId, { title: 'Con caso ajeno' }).field('caseId', 'otro-caso').expect(404);

      const ok = await send(root, clientId).expect(201);
      expect(ok.body).toMatchObject({ title: 'Contrato de servicios', category: 'CONTRACT', description: 'Versión firmada', originalName: 'contrato.pdf', mimeType: 'application/pdf', viewedAt: null });
      expect(ok.body.storageKey).toBeUndefined();
      docId = ok.body.id;
      const png = await root.post(`/api/admin/clients/${clientId}/issued-documents`).field('title', 'Constancia escaneada').field('category', 'CERTIFICATE').attach('file', PNG, { filename: 'constancia.png', contentType: 'image/png' }).expect(201);
      expect(png.body.mimeType).toBe('image/png');
    });

    it('el cliente recibe una alerta, ve solo lo suyo y la primera descarga marca el documento como visto', async () => {
      const alerts = await client.get('/api/notifications').expect(200);
      expect(alerts.body.items.find((n: { title: string }) => n.title === 'Nuevo documento del despacho')).toMatchObject({ type: 'DOCUMENT', body: expect.any(String), link: '/dashboard/documentos?tab=recibidos' });

      const list = await client.get('/api/issued-documents').expect(200);
      expect(list.body).toHaveLength(2);
      expect(list.body.find((d: { id: string }) => d.id === docId).viewedAt).toBeNull();
      expect((await stranger.get('/api/issued-documents').expect(200)).body).toEqual([]);

      await stranger.get(`/api/issued-documents/${docId}/download`).expect(404);
      await anon().get(`/api/issued-documents/${docId}/download`).expect(401);
      const dl = await client.get(`/api/issued-documents/${docId}/download`).buffer(true).expect(200);
      expect(dl.headers['content-type']).toContain('application/pdf');
      expect(dl.headers['content-disposition']).toContain("filename*=UTF-8''contrato.pdf");
      const after = (await client.get('/api/issued-documents').expect(200)).body.find((d: { id: string }) => d.id === docId);
      expect(after.viewedAt).not.toBeNull();

      // El personal no usa la ruta del cliente.
      await root.get('/api/issued-documents').expect(403);
    });

    it('el superadmin consulta lo entregado (con los casos del cliente), lo descarga con rastro y lo retira', async () => {
      const view = await root.get(`/api/admin/clients/${clientId}/issued-documents`).expect(200);
      expect(view.body.client).toMatchObject({ id: clientId, fullName: 'Carlos Cliente Pérez' });
      expect(view.body.items).toHaveLength(2);
      await lawyer.get(`/api/admin/clients/${clientId}/issued-documents`).expect(403);
      await root.get(`/api/admin/issued-documents/${docId}/download`).buffer(true).expect(200);

      await root.delete(`/api/admin/issued-documents/${docId}`).expect(200);
      await client.get(`/api/issued-documents/${docId}/download`).expect(404);
      await root.delete(`/api/admin/issued-documents/${docId}`).expect(404);
      expect((await client.get('/api/issued-documents').expect(200)).body).toHaveLength(1);

      const actions = new Set((await prisma.auditLog.findMany({ where: { entity: 'IssuedDocument' } })).map((a) => a.action));
      for (const a of ['ISSUED_DOCUMENT_UPLOADED', 'ISSUED_DOCUMENT_DOWNLOADED', 'ISSUED_DOCUMENT_DELETED']) expect(actions).toContain(a);
      expect(strangerId).toBeTruthy();
    });
  });
});

function writeTemp(buffer: Buffer): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'pdf-')), 'a.pdf');
  writeFileSync(file, buffer);
  return file;
}
