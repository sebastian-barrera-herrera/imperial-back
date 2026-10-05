import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { createApp, createStaff, login, registerClient } from './helpers';

type Agent = ReturnType<typeof request.agent>;

// PNG de 1×1 píxel (válido) y cabecera mínima de WebP: la API solo mira los primeros bytes.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([4, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('Contenido del sitio (equipo y testimonios)', () => {
  let app: INestApplication;
  let prisma: PrismaClient;
  let root: Agent;
  let lawyer: Agent;
  let client: Agent;
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
    await prisma.$disconnect();
    await app.close();
  });

  it('sin contenido configurado, la web pública recibe null (usa su respaldo)', async () => {
    const res = await anon().get('/api/public/content').expect(200);
    expect(res.body).toEqual({ team: null, testimonials: null });
  });

  it('solo el superadmin gestiona el contenido', async () => {
    await anon().get('/api/admin/content').expect(401);
    await client.get('/api/admin/content').expect(403);
    await lawyer.get('/api/admin/content').expect(403);
    await lawyer.post('/api/admin/content/team').send({ name: 'Intruso', role: 'Abogado', bio: 'No debería poder.', authorized: true }).expect(403);
    await lawyer.post('/api/admin/content/images').attach('file', PNG, 'a.png').expect(403);
    await root.get('/api/admin/content').expect(200);
  });

  it('carga el contenido de ejemplo rotulado y no lo duplica', async () => {
    const res = await root.post('/api/admin/content/samples').expect(200);
    expect(res.body).toEqual({ team: 4, testimonials: 3 });
    await root.post('/api/admin/content/samples').expect(409);

    const pub = await anon().get('/api/public/content').expect(200);
    expect(pub.body.team).toHaveLength(4);
    expect(pub.body.team.every((m: { isSample: boolean }) => m.isSample)).toBe(true);
    expect(pub.body.testimonials).toHaveLength(3);
  });

  it('reemplazar un ejemplo exige confirmar la autorización y deja de rotularlo como ejemplo', async () => {
    const admin = (await root.get('/api/admin/content').expect(200)).body;
    const t = admin.testimonials[0];
    await root.patch(`/api/admin/content/testimonials/${t.id}`).send({ quote: 'Texto real del cliente autorizado.' }).expect(400);
    await root.patch(`/api/admin/content/testimonials/${t.id}`).send({ quote: 'Texto real del cliente autorizado.', author: 'Ana P.', authorized: true }).expect(200);

    const after = (await root.get('/api/admin/content').expect(200)).body.testimonials.find((x: { id: string }) => x.id === t.id);
    expect(after).toMatchObject({ quote: 'Texto real del cliente autorizado.', author: 'Ana P.', isSample: false, authorized: true });
    expect(after.authorizedBy).toBe('root@example.com');
  });

  it('cambiar el texto de un testimonio real vuelve a exigir autorización; ocultarlo no', async () => {
    const t = (await root.get('/api/admin/content').expect(200)).body.testimonials[0];
    await root.patch(`/api/admin/content/testimonials/${t.id}`).send({ quote: 'Ahora dice otra cosa distinta.' }).expect(400);
    await root.patch(`/api/admin/content/testimonials/${t.id}`).send({ published: false }).expect(200);
    const pub = (await anon().get('/api/public/content').expect(200)).body;
    expect(pub.testimonials).toHaveLength(2); // el oculto no sale
    await root.patch(`/api/admin/content/testimonials/${t.id}`).send({ published: true }).expect(200);
  });

  it('crea perfiles y testimonios nuevos solo con autorización confirmada', async () => {
    const body = { name: 'Dr. Real Persona', role: 'Socio', bio: 'Perfil de una persona real del despacho.' };
    await root.post('/api/admin/content/team').send(body).expect(400);
    await root.post('/api/admin/content/team').send({ ...body, authorized: false }).expect(400);
    const created = await root.post('/api/admin/content/team').send({ ...body, authorized: true }).expect(201);
    const list = (await root.get('/api/admin/content').expect(200)).body.team;
    expect(list[list.length - 1]).toMatchObject({ id: created.body.id, name: 'Dr. Real Persona', isSample: false, authorized: true, published: true });

    // Validación de longitudes y campos desconocidos
    await root.post('/api/admin/content/team').send({ name: 'X', role: 'Socio', bio: 'Corto.', authorized: true }).expect(400);
    await root.post('/api/admin/content/testimonials').send({ quote: 'corto', author: 'Ana', kind: 'Cliente', authorized: true }).expect(400);
    await root.post('/api/admin/content/team').send({ ...body, authorized: true, isSample: false }).expect(400);
  });

  describe('fotos', () => {
    let memberId: string;
    let imageId: string;

    it('solo acepta JPG, PNG o WebP reales (no por el nombre ni el Content-Type)', async () => {
      await root.post('/api/admin/content/images').attach('file', SVG, { filename: 'x.png', contentType: 'image/png' }).expect(400);
      await root.post('/api/admin/content/images').attach('file', Buffer.from('%PDF-1.4\n%%EOF   '), { filename: 'x.png', contentType: 'image/png' }).expect(400);
      await root.post('/api/admin/content/images').expect(400);
      await root.post('/api/admin/content/images').attach('file', Buffer.alloc(5 * 1024 * 1024 + 10, 1), { filename: 'big.png', contentType: 'image/png' }).expect(413);
      const webp = await root.post('/api/admin/content/images').attach('file', WEBP, 'f.webp').expect(201);
      expect(webp.body.id).toBeTruthy();
      const png = await root.post('/api/admin/content/images').attach('file', PNG, 'f.png').expect(201);
      imageId = png.body.id;
    });

    it('una foto sin publicar no es pública; al publicar el perfil sí, con el tipo correcto', async () => {
      const created = await root.post('/api/admin/content/team').send({ name: 'Dra. Con Foto', role: 'Abogada', bio: 'Perfil con foto subida.', photoId: imageId, published: false, authorized: true }).expect(201);
      memberId = created.body.id;
      await anon().get(`/api/public/content/images/${imageId}`).expect(404);
      const asAdmin = await root.get(`/api/admin/content/images/${imageId}`).expect(200);
      expect(asAdmin.headers['content-type']).toContain('image/png');
      await client.get(`/api/admin/content/images/${imageId}`).expect(403);

      await root.patch(`/api/admin/content/team/${memberId}`).send({ published: true }).expect(200);
      const pub = await anon().get(`/api/public/content/images/${imageId}`).expect(200);
      expect(pub.headers['content-type']).toContain('image/png');
      expect(pub.headers['x-content-type-options']).toBe('nosniff');
      const listed = (await anon().get('/api/public/content').expect(200)).body.team.find((m: { id: string }) => m.id === memberId);
      expect(listed.photoUrl).toBe(`/api/public/content/images/${imageId}`);
    });

    it('cambiar la foto exige autorización y borra la anterior si nadie la usa; una foto inexistente se rechaza', async () => {
      await root.patch(`/api/admin/content/team/${memberId}`).send({ photoId: 'no-existe', authorized: true }).expect(400);
      const next = (await root.post('/api/admin/content/images').attach('file', WEBP, 'n.webp').expect(201)).body.id;
      await root.patch(`/api/admin/content/team/${memberId}`).send({ photoId: next }).expect(400);
      await root.patch(`/api/admin/content/team/${memberId}`).send({ photoId: next, authorized: true }).expect(200);
      await root.get(`/api/admin/content/images/${imageId}`).expect(404); // la anterior se eliminó
      await anon().get(`/api/public/content/images/${next}`).expect(200);
      // quitar la foto
      await root.patch(`/api/admin/content/team/${memberId}`).send({ photoId: null, authorized: true }).expect(200);
      await root.get(`/api/admin/content/images/${next}`).expect(404);
    });

    it('eliminar el perfil elimina su foto', async () => {
      const img = (await root.post('/api/admin/content/images').attach('file', PNG, 'z.png').expect(201)).body.id;
      const m = (await root.post('/api/admin/content/team').send({ name: 'Dr. Temporal', role: 'Abogado', bio: 'Se elimina enseguida.', photoId: img, authorized: true }).expect(201)).body.id;
      await root.delete(`/api/admin/content/team/${m}`).expect(200);
      await root.get(`/api/admin/content/images/${img}`).expect(404);
      await root.delete(`/api/admin/content/team/${m}`).expect(404);
    });
  });

  it('reordena y exige la lista completa', async () => {
    const ids: string[] = (await root.get('/api/admin/content').expect(200)).body.team.map((m: { id: string }) => m.id);
    await root.put('/api/admin/content/team/order').send({ ids: ids.slice(1) }).expect(400);
    await root.put('/api/admin/content/team/order').send({ ids: [...ids.slice(1), ids[0], ids[0]] }).expect(400);
    const reversed = [...ids].reverse();
    await root.put('/api/admin/content/team/order').send({ ids: reversed }).expect(200);
    const after: string[] = (await root.get('/api/admin/content').expect(200)).body.team.map((m: { id: string }) => m.id);
    expect(after).toEqual(reversed);
    const pub: string[] = (await anon().get('/api/public/content').expect(200)).body.team.map((m: { id: string }) => m.id);
    expect(pub).toEqual(reversed.filter((id) => pub.includes(id)));
  });

  it('deja rastro en la auditoría', async () => {
    const res = await root.get('/api/admin/audit?pageSize=100').expect(200);
    const actions = new Set((res.body.items as { action: string }[]).map((a) => a.action));
    for (const a of ['CONTENT_SAMPLES_IMPORTED', 'CONTENT_CREATED', 'CONTENT_UPDATED', 'CONTENT_DELETED', 'CONTENT_IMAGE_UPLOADED', 'CONTENT_REORDERED']) expect(actions).toContain(a);
  });
});
