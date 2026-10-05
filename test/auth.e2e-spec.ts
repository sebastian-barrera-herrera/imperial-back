import { INestApplication } from '@nestjs/common';
import { PrismaClient, Role } from '@prisma/client';
import request from 'supertest';
import { PASSWORD, createApp, createStaff, login, registerClient } from './helpers';

describe('Auth y RBAC', () => {
  let app: INestApplication;
  let prisma: PrismaClient;

  beforeAll(async () => ({ app, prisma } = await createApp()));
  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('registra un cliente, entrega cookies httpOnly y /auth/me responde', async () => {
    const res = await request(app.getHttpServer())
      .post('/api/auth/register')
      .send({ fullName: 'Ana Pérez', email: 'Ana@Example.com', password: PASSWORD, acceptPrivacy: true })
      .expect(201);
    expect(res.body).toMatchObject({ email: 'ana@example.com', role: 'CLIENT' });
    expect(res.body.passwordHash).toBeUndefined();
    const cookies = res.headers['set-cookie'] as unknown as string[];
    expect(cookies.some((c) => c.startsWith('ilg_at=') && c.includes('HttpOnly'))).toBe(true);
    expect(cookies.some((c) => c.startsWith('ilg_rt=') && c.includes('HttpOnly') && c.includes('Path=/api/auth'))).toBe(true);

    const agent = await login(app, 'ana@example.com');
    const me = await agent.get('/api/auth/me').expect(200);
    expect(me.body.email).toBe('ana@example.com');
  });

  it('exige aceptar la política de privacidad y deja constancia de la versión aceptada', async () => {
    const http = request(app.getHttpServer());
    await http.post('/api/auth/register').send({ fullName: 'Sin Consentimiento', email: 'sin-consent@example.com', password: PASSWORD }).expect(400);
    await http.post('/api/auth/register').send({ fullName: 'Sin Consentimiento', email: 'sin-consent@example.com', password: PASSWORD, acceptPrivacy: false }).expect(400);
    expect(await prisma.user.findUnique({ where: { email: 'sin-consent@example.com' } })).toBeNull();

    await http.post('/api/auth/register').send({ fullName: 'Con Consentimiento', email: 'con-consent@example.com', password: PASSWORD, acceptPrivacy: true }).expect(201);
    const saved = await prisma.user.findUniqueOrThrow({ where: { email: 'con-consent@example.com' } });
    expect(saved.privacyAcceptedAt).toBeInstanceOf(Date);
    expect(saved.privacyVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('rechaza correo duplicado, contraseña débil, campos extra y login incorrecto', async () => {
    const http = request(app.getHttpServer());
    await http.post('/api/auth/register').send({ fullName: 'Otra Ana', email: 'ana@example.com', password: PASSWORD, acceptPrivacy: true }).expect(409);
    await http.post('/api/auth/register').send({ fullName: 'Débil', email: 'debil@example.com', password: 'corta1', acceptPrivacy: true }).expect(400);
    await http.post('/api/auth/register').send({ fullName: 'Listo', email: 'listo@example.com', password: PASSWORD, acceptPrivacy: true, role: 'SUPERADMIN' }).expect(400);
    await http.post('/api/auth/login').send({ email: 'ana@example.com', password: 'incorrecta123' }).expect(401);
    await http.post('/api/auth/login').send({ email: 'noexiste@example.com', password: PASSWORD }).expect(401);
  });

  it('exige sesión y respeta los roles', async () => {
    await request(app.getHttpServer()).get('/api/profile').expect(401);
    await request(app.getHttpServer()).get('/api/health').expect(200);

    const { agent } = await registerClient(app, 'cliente-rbac@example.com');
    for (const path of ['/api/admin/users', '/api/admin/documents', '/api/admin/disbursements', '/api/admin/cases', '/api/admin/stats', '/api/admin/audit', '/api/admin/reports/users.csv', '/api/admin/investments/opportunities']) {
      await agent.get(path).expect(403);
    }

    await createStaff(prisma, 'abogado-rbac@example.com', Role.LAWYER);
    const lawyer = await login(app, 'abogado-rbac@example.com');
    await lawyer.get('/api/admin/documents').expect(200);
    await lawyer.get('/api/admin/stats').expect(200);
    // El abogado no gestiona usuarios, auditoría ni capital.
    for (const path of ['/api/admin/users', '/api/admin/audit', '/api/admin/reports/users.csv', '/api/admin/investments/opportunities']) {
      await lawyer.get(path).expect(403);
    }
  });

  it('rota el refresh token y detecta la reutilización de uno revocado', async () => {
    const agent = request.agent(app.getHttpServer());
    const first = await agent.post('/api/auth/login').send({ email: 'ana@example.com', password: PASSWORD }).expect(200);
    const oldRefresh = (first.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('ilg_rt='))!.split(';')[0];

    await agent.post('/api/auth/refresh').expect(200);
    await agent.get('/api/auth/me').expect(200);

    // Reusar el token anterior (robado) invalida toda la familia de sesiones.
    await request(app.getHttpServer()).post('/api/auth/refresh').set('Cookie', oldRefresh).expect(401);
    await agent.post('/api/auth/refresh').expect(401);
  });

  it('cierra sesión y aplica la suspensión al instante', async () => {
    const agent = await login(app, 'ana@example.com');
    await agent.post('/api/auth/logout').expect(200);
    await agent.post('/api/auth/refresh').expect(401);

    const { agent: victim, user } = await registerClient(app, 'suspendido@example.com');
    await victim.get('/api/auth/me').expect(200);
    await createStaff(prisma, 'root-rbac@example.com', Role.SUPERADMIN);
    const root = await login(app, 'root-rbac@example.com');
    await root.patch(`/api/admin/users/${user.id}`).send({ status: 'SUSPENDED' }).expect(200);
    await victim.get('/api/auth/me').expect(401);
    // Con la contraseña correcta recibe un aviso claro de que su acceso fue desactivado; con una incorrecta, el mensaje genérico.
    const blocked = await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'suspendido@example.com', password: PASSWORD }).expect(403);
    expect(blocked.body.message).toContain('desactivado');
    await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'suspendido@example.com', password: 'Incorrecta123' }).expect(401);
  });

  it('el superadmin gestiona usuarios pero no puede dejar el sistema sin superadmin', async () => {
    const root = await login(app, 'root-rbac@example.com');
    const rootUser = await prisma.user.findUniqueOrThrow({ where: { email: 'root-rbac@example.com' } });

    const created = await root.post('/api/admin/users').send({ fullName: 'Nuevo Abogado', email: 'nuevo@example.com', role: 'LAWYER' }).expect(201);
    expect(created.body.temporaryPassword).toHaveLength(14);
    await login(app, 'nuevo@example.com', created.body.temporaryPassword);

    await root.patch(`/api/admin/users/${rootUser.id}`).send({ role: 'CLIENT' }).expect(403);
    await root.patch(`/api/admin/users/${rootUser.id}`).send({ status: 'SUSPENDED' }).expect(403);

    const audit = await root.get('/api/admin/audit').query({ action: 'USER_CREATED' }).expect(200);
    expect(audit.body.total).toBeGreaterThanOrEqual(1);
  });

  it('cambia la contraseña verificando la actual y cierra otras sesiones', async () => {
    const { agent } = await registerClient(app, 'cambio@example.com');
    const other = await login(app, 'cambio@example.com');
    await agent.post('/api/auth/change-password').send({ currentPassword: 'mala-mala-123', newPassword: 'NuevaClave12345' }).expect(400);
    await agent.get('/api/auth/me').expect(200); // equivocarse de contraseña no cierra la sesión
    await agent.post('/api/auth/change-password').send({ currentPassword: PASSWORD, newPassword: 'NuevaClave12345' }).expect(200);
    await agent.get('/api/auth/me').expect(200);
    await other.post('/api/auth/refresh').expect(401);
    await request(app.getHttpServer()).post('/api/auth/login').send({ email: 'cambio@example.com', password: 'NuevaClave12345' }).expect(200);
  });
});
