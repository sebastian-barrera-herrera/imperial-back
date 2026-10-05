import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/setup';

export const PASSWORD = 'Password12345';

export async function createApp(): Promise<{ app: INestApplication; prisma: PrismaClient }> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = moduleRef.createNestApplication();
  configureApp(app);
  await app.init();
  const prisma = new PrismaClient();
  await resetDb(prisma);
  return { app, prisma };
}

export async function resetDb(prisma: PrismaClient) {
  const tables = await prisma.$queryRaw<{ tablename: string }[]>`SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`;
  const list = tables.map((t) => `"public"."${t.tablename}"`).join(', ');
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${list} RESTART IDENTITY CASCADE`);
}

/** Crea un usuario de personal directamente en la base (el registro público solo crea clientes). */
export async function createStaff(prisma: PrismaClient, email: string, role: Role = Role.LAWYER, fullName = 'Personal Prueba') {
  return prisma.user.create({
    data: { email, fullName, role, passwordHash: await bcrypt.hash(PASSWORD, 4), profile: { create: {} }, preference: { create: {} } },
  });
}

/** Agente de supertest con cookies persistentes ya autenticado. */
export async function login(app: INestApplication, email: string, password = PASSWORD) {
  const agent = request.agent(app.getHttpServer());
  await agent.post('/api/auth/login').send({ email, password }).expect(200);
  return agent;
}

export async function registerClient(app: INestApplication, email: string, fullName = 'Cliente Prueba') {
  const agent = request.agent(app.getHttpServer());
  const res = await agent.post('/api/auth/register').send({ fullName, email, password: PASSWORD, acceptPrivacy: true }).expect(201);
  return { agent, user: res.body as { id: string; email: string; role: Role } };
}

let counter = 0;
/** PDF mínimo pero con la firma correcta; el contenido cambia en cada llamada para evitar duplicados. */
export const fakePdf = () => Buffer.from(`%PDF-1.4\n% archivo de prueba ${Date.now()}-${counter++}\n%%EOF`);
