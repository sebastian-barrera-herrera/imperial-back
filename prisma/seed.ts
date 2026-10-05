import 'dotenv/config'; // carga .env aunque se haya creado después de `npm install`
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

const prisma = new PrismaClient();

/**
 * Crea (o actualiza) el superadmin inicial a partir de variables de entorno.
 * Uso: SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... npm run seed
 */
async function main() {
  const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD;
  const fullName = process.env.SUPERADMIN_NAME ?? 'Superadministrador';
  if (!email || !password) {
    throw new Error('Define SUPERADMIN_EMAIL y SUPERADMIN_PASSWORD para crear el superadmin inicial.');
  }
  if (!/^(?=.*[A-Za-z])(?=.*\d).{10,72}$/.test(password)) {
    throw new Error('SUPERADMIN_PASSWORD debe tener 10-72 caracteres con al menos una letra y un número.');
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const user = await prisma.user.upsert({
    where: { email },
    create: { email, fullName, passwordHash, role: Role.SUPERADMIN, profile: { create: {} }, preference: { create: {} } },
    update: { passwordHash, role: Role.SUPERADMIN, status: 'ACTIVE' },
  });
  console.log(`Superadmin listo: ${user.email}`);
}

main()
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
