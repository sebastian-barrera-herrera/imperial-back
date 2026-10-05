import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit() {
    await this.$connect();
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }

  /** Código secuencial atómico por año, p. ej. DES-2026-00001. */
  async nextCode(prefix: string, tx?: Prisma.TransactionClient): Promise<string> {
    const db = tx ?? this;
    const key = `${prefix}-${new Date().getFullYear()}`;
    const counter = await db.counter.upsert({
      where: { key },
      create: { key, value: 1 },
      update: { value: { increment: 1 } },
    });
    return `${key}-${String(counter.value).padStart(5, '0')}`;
  }
}
