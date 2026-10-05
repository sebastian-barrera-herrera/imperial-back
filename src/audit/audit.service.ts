import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { getRequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';

export type AuditEntry = {
  actor?: { id: string; email: string } | null;
  action: string;
  entity: string;
  entityId?: string;
  metadata?: Prisma.InputJsonValue;
};

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  log(entry: AuditEntry, tx?: Prisma.TransactionClient) {
    const db = tx ?? this.prisma;
    return db.auditLog.create({
      data: {
        actorId: entry.actor?.id,
        actorEmail: entry.actor?.email,
        action: entry.action,
        entity: entry.entity,
        entityId: entry.entityId,
        metadata: entry.metadata,
        ip: getRequestContext().ip,
      },
    });
  }
}
