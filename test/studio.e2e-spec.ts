import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import { createHash } from 'crypto';
import request from 'supertest';
import { createApp, createStaff, login, registerClient } from './helpers';

type Agent = ReturnType<typeof request.agent>;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const EDITED = Buffer.concat([PNG, Buffer.from('editada')]); // PNG válido con bytes distintos
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(40, 7)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const edit = (over: Record<string, unknown> = {}) => ({ x: 10, y: 20, w: 200, h: 40, text: 'Nuevo título', font: 'sans', size: 32, color: '#1d344a', bold: true, italic: false, align: 'left', ...over });
const binary = (agent: Agent, url: string) => agent.get(url).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on('data', (d: Buffer) => c.push(d)); res.on('end', () => cb(null, Buffer.concat(c))); });

describe('Editor de imágenes (piezas propias)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let root: Agent;
  let lawyer: Agent;
  let client: Agent;
  let imageId: string;
  const anon = () => request(app.getHttpServer());

  beforeAll(async () => {
    ({ app, prisma } = await createApp());
    await createStaff(prisma, 'root@example.com', Role.SUPERADMIN);
    await createStaff(prisma, 'abogado@example.com', Role.LAWYER);
    root = await login(app, 'root@example.com');
    lawyer = await login(app, 'abogado@example.com');
    client = (await registerClient(app, 'cliente@example.com')).agent;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('solo el superadmin accede', async () => {
    await anon().get('/api/admin/studio/images').expect(401);
    await client.get('/api/admin/studio/images').expect(403);
    await lawyer.get('/api/admin/studio/images').expect(403);
    await lawyer.post('/api/admin/studio/images').attach('file', PNG, 'a.png').expect(403);
    expect((await root.get('/api/admin/studio/images').expect(200)).body).toEqual([]);
  });

  it('acepta solo JPG, PNG o WebP reales (no SVG ni PDF) y rechaza archivos enormes', async () => {
    await root.post('/api/admin/studio/images').attach('file', SVG, { filename: 'x.png', contentType: 'image/png' }).expect(400);
    await root.post('/api/admin/studio/images').attach('file', Buffer.from('%PDF-1.4\n%%EOF   '), { filename: 'x.png', contentType: 'image/png' }).expect(400);
    await root.post('/api/admin/studio/images').expect(400);
    await root.post('/api/admin/studio/images').attach('file', Buffer.alloc(15 * 1024 * 1024 + 10, 1), { filename: 'big.png', contentType: 'image/png' }).expect(413);
  });

  it('sube un original, lo conserva intacto y registra su huella', async () => {
    const res = await root.post('/api/admin/studio/images').field('title', 'Flyer de octubre').attach('file', PNG, { filename: 'flyer.png', contentType: 'image/png' }).expect(201);
    expect(res.body).toMatchObject({ title: 'Flyer de octubre', originalName: 'flyer.png', mime: 'image/png', size: PNG.length, versionCount: 0, latestVersionId: null, createdByEmail: 'root@example.com' });
    imageId = res.body.id;

    const original = await binary(root, `/api/admin/studio/images/${imageId}/original`).expect(200);
    expect(original.headers['content-type']).toContain('image/png');
    expect(sha(original.body as Buffer)).toBe(sha(PNG));
    const detail = (await root.get(`/api/admin/studio/images/${imageId}`).expect(200)).body;
    expect(detail.originalSha256).toBe(sha(PNG));
    expect(detail.versions).toEqual([]);

    // Sin título usa el nombre del archivo.
    const jpg = await root.post('/api/admin/studio/images').attach('file', JPG, { filename: 'Banner Evento.jpg', contentType: 'image/jpeg' }).expect(201);
    expect(jpg.body.title).toBe('Banner Evento');
  });

  it('cada edición se guarda como versión nueva sin tocar el original', async () => {
    await root.post(`/api/admin/studio/images/${imageId}/versions`).field('edits', '[]').expect(400); // sin archivo
    await root.post(`/api/admin/studio/images/${imageId}/versions`).field('edits', '[]').attach('file', SVG, { filename: 'v.png', contentType: 'image/png' }).expect(400);
    await root.post(`/api/admin/studio/images/${imageId}/versions`).field('edits', 'no-json').attach('file', EDITED, 'v.png').expect(400);
    await root.post(`/api/admin/studio/images/${imageId}/versions`).field('edits', JSON.stringify([edit({ color: 'rojo' })])).attach('file', EDITED, 'v.png').expect(400);
    await root.post(`/api/admin/studio/images/${imageId}/versions`).field('edits', JSON.stringify([edit({ w: -5 })])).attach('file', EDITED, 'v.png').expect(400);
    await root.post(`/api/admin/studio/images/${imageId}/versions`).field('edits', JSON.stringify(Array.from({ length: 101 }, () => edit()))).attach('file', EDITED, 'v.png').expect(400);
    await root.post('/api/admin/studio/images/no-existe/versions').field('edits', '[]').attach('file', EDITED, 'v.png').expect(404);

    const v1 = await root.post(`/api/admin/studio/images/${imageId}/versions`).field('label', 'Título nuevo').field('edits', JSON.stringify([edit()])).attach('file', EDITED, { filename: 'v.png', contentType: 'image/png' }).expect(201);
    expect(v1.body).toMatchObject({ version: 1, label: 'Título nuevo', size: EDITED.length });
    const v2 = await root.post(`/api/admin/studio/images/${imageId}/versions`).field('edits', JSON.stringify([edit(), edit({ text: 'Otro texto', y: 90 })])).attach('file', Buffer.concat([EDITED, Buffer.from('2')]), 'v2.png').expect(201);
    expect(v2.body).toMatchObject({ version: 2, label: 'Versión 2' });

    const detail = (await root.get(`/api/admin/studio/images/${imageId}`).expect(200)).body;
    expect(detail.versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect(detail.versions[1].edits[0]).toMatchObject({ text: 'Nuevo título', size: 32 });
    expect(detail.versions[0].edits).toHaveLength(2);
    expect(detail.versions[1].sha256).toBe(sha(EDITED));
    expect(detail.latestVersionId).toBe(v2.body.id);

    // El original sigue idéntico
    const original = await binary(root, `/api/admin/studio/images/${imageId}/original`).expect(200);
    expect(sha(original.body as Buffer)).toBe(sha(PNG));
    expect((await root.get('/api/admin/studio/images').expect(200)).body.find((i: { id: string }) => i.id === imageId).versionCount).toBe(2);
  });

  it('descarga una versión como adjunto con nombre claro y deja rastro', async () => {
    const detail = (await root.get(`/api/admin/studio/images/${imageId}`).expect(200)).body;
    const v1 = detail.versions.find((v: { version: number }) => v.version === 1);
    const inline = await binary(root, `/api/admin/studio/versions/${v1.id}`).expect(200);
    expect(inline.headers['content-disposition']).toContain('inline');
    const dl = await binary(root, `/api/admin/studio/versions/${v1.id}?download=1`).expect(200);
    expect(dl.headers['content-disposition']).toContain("attachment; filename*=UTF-8''Flyer%20de%20octubre-v1.png");
    expect(sha(dl.body as Buffer)).toBe(sha(EDITED));
    await lawyer.get(`/api/admin/studio/versions/${v1.id}`).expect(403);
    await client.get(`/api/admin/studio/versions/${v1.id}`).expect(403);
    await root.get('/api/admin/studio/versions/no-existe').expect(404);
  });

  it('eliminar la imagen borra sus versiones y todo queda en la auditoría con las huellas', async () => {
    await lawyer.delete(`/api/admin/studio/images/${imageId}`).expect(403);
    await root.delete(`/api/admin/studio/images/${imageId}`).expect(200);
    await root.get(`/api/admin/studio/images/${imageId}`).expect(404);
    await root.delete(`/api/admin/studio/images/${imageId}`).expect(404);
    expect(await prisma.studioVersion.count({ where: { imageId } })).toBe(0);

    const logs = await prisma.auditLog.findMany({ where: { action: { startsWith: 'STUDIO_' } }, orderBy: { createdAt: 'asc' } });
    const actions = logs.map((l) => l.action);
    for (const a of ['STUDIO_IMAGE_UPLOADED', 'STUDIO_VERSION_SAVED', 'STUDIO_VERSION_DOWNLOADED', 'STUDIO_IMAGE_DELETED']) expect(actions).toContain(a);
    const saved = logs.find((l) => l.action === 'STUDIO_VERSION_SAVED')!.metadata as Record<string, unknown>;
    expect(saved).toMatchObject({ version: 1, edits: 1, sha256: sha(EDITED), originalSha256: sha(PNG) });
  });
});
