import { BadRequestException, ConflictException, Injectable, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DisbursementStatus, DocumentStatus, Prisma, Role, UserStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

export const STATUS_LABELS: Record<DisbursementStatus, string> = {
  PENDING: 'Pendiente',
  APPROVED: 'Aprobada',
  IN_PROCESS: 'En proceso',
  DISBURSED: 'Desembolsada',
  REJECTED: 'Rechazada',
  CANCELLED: 'Cancelada',
};

/** Flujo permitido: Pendiente → Aprobada → En proceso → Desembolsada (rechazo posible hasta antes de desembolsar). */
export const TRANSITIONS: Record<DisbursementStatus, DisbursementStatus[]> = {
  PENDING: ['APPROVED', 'REJECTED'],
  APPROVED: ['IN_PROCESS', 'REJECTED'],
  IN_PROCESS: ['DISBURSED', 'REJECTED'],
  DISBURSED: [],
  REJECTED: [],
  CANCELLED: [],
};

const detailInclude = {
  events: { orderBy: { createdAt: 'asc' as const } },
  documents: { orderBy: { createdAt: 'desc' as const }, select: { id: true, category: true, originalName: true, status: true, mimeType: true, size: true, createdAt: true } },
  case: { select: { id: true, number: true, title: true } },
} satisfies Prisma.DisbursementRequestInclude;

@Injectable()
export class DisbursementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  async create(user: AuthUser, dto: { amount: number; concept: string; caseId?: string; documentIds?: string[] }) {
    const profile = await this.prisma.profile.findUnique({ where: { userId: user.id } });
    if (!profile?.bankName || !profile.accountNumberEnc) {
      throw new UnprocessableEntityException('Completa tus datos bancarios en "Mi Perfil" antes de solicitar un desembolso');
    }

    // Flujo: el cliente debe tener identidad y soporte bancario validados antes de pedir un desembolso.
    const validated = await this.prisma.document.groupBy({
      by: ['category'],
      where: { ownerId: user.id, status: DocumentStatus.VALIDATED, category: { in: ['IDENTITY', 'BANKING'] } },
    });
    const have = new Set(validated.map((v) => v.category));
    const missing = (['IDENTITY', 'BANKING'] as const).filter((c) => !have.has(c));
    if (missing.length) {
      const names = missing.map((c) => (c === 'IDENTITY' ? 'identidad' : 'bancarios')).join(' y ');
      throw new UnprocessableEntityException(`Necesitas al menos un documento ${names} validado antes de solicitar un desembolso`);
    }

    if (dto.caseId) {
      const own = await this.prisma.case.findFirst({ where: { id: dto.caseId, clientId: user.id }, select: { id: true } });
      if (!own) throw new NotFoundException('Caso no encontrado');
    }
    const documentIds = [...new Set(dto.documentIds ?? [])];
    if (documentIds.length) {
      const owned = await this.prisma.document.count({ where: { id: { in: documentIds }, ownerId: user.id } });
      if (owned !== documentIds.length) throw new BadRequestException('Alguno de los documentos adjuntos no existe');
    }

    const request = await this.prisma.$transaction(async (tx) => {
      const created = await tx.disbursementRequest.create({
        data: {
          code: await this.prisma.nextCode('DES', tx),
          clientId: user.id,
          caseId: dto.caseId,
          amount: dto.amount,
          currency: this.config.get<string>('DEFAULT_CURRENCY') ?? 'USD',
          concept: dto.concept.trim(),
          bankName: profile.bankName,
          accountLast4: profile.accountLast4,
          events: { create: { toStatus: 'PENDING', note: 'Solicitud creada', actorId: user.id, actorName: user.fullName } },
        },
      });
      if (documentIds.length) await tx.document.updateMany({ where: { id: { in: documentIds }, ownerId: user.id }, data: { disbursementId: created.id } });
      await this.audit.log({ actor: user, action: 'DISBURSEMENT_CREATED', entity: 'DisbursementRequest', entityId: created.id, metadata: { code: created.code, amount: dto.amount } }, tx);
      return created;
    });

    const staff = await this.prisma.user.findMany({ where: { role: { in: [Role.SUPERADMIN, Role.LAWYER] }, status: UserStatus.ACTIVE }, select: { id: true } });
    await this.notifications.notifyMany(staff.map((s) => s.id), {
      type: 'DISBURSEMENT',
      title: 'Nueva solicitud de desembolso',
      body: `${user.fullName} solicitó ${request.code}.`,
      link: '/admin/desembolsos',
    });
    return this.detail(user.id, request.id);
  }

  listOwn(userId: string, status?: DisbursementStatus) {
    return this.prisma.disbursementRequest.findMany({
      where: { clientId: userId, ...(status ? { status } : {}) },
      orderBy: { createdAt: 'desc' },
      include: { case: { select: { number: true } } },
    });
  }

  async detail(userId: string | null, id: string) {
    const request = await this.prisma.disbursementRequest.findFirst({
      where: { id, ...(userId ? { clientId: userId } : {}) },
      include: { ...detailInclude, client: { select: { id: true, fullName: true, email: true } } },
    });
    if (!request) throw new NotFoundException('Solicitud no encontrada');
    return request;
  }

  async cancel(user: AuthUser, id: string) {
    const request = await this.prisma.disbursementRequest.findFirst({ where: { id, clientId: user.id } });
    if (!request) throw new NotFoundException('Solicitud no encontrada');
    if (request.status !== 'PENDING') throw new ConflictException('Solo se pueden cancelar solicitudes pendientes');
    await this.transition(user, request.id, 'CANCELLED', 'Cancelada por el cliente', { notifyClient: false });
    return this.detail(user.id, id);
  }

  async attachDocuments(user: AuthUser, id: string, documentIds: string[]) {
    const request = await this.prisma.disbursementRequest.findFirst({ where: { id, clientId: user.id } });
    if (!request) throw new NotFoundException('Solicitud no encontrada');
    if (TRANSITIONS[request.status].length === 0) throw new ConflictException('La solicitud ya está cerrada');
    const owned = await this.prisma.document.count({ where: { id: { in: documentIds }, ownerId: user.id } });
    if (owned !== new Set(documentIds).size) throw new BadRequestException('Alguno de los documentos no existe');
    await this.prisma.document.updateMany({ where: { id: { in: documentIds }, ownerId: user.id }, data: { disbursementId: id } });
    return this.detail(user.id, id);
  }

  /** Cambio de estado con validación de flujo, historial, auditoría y alerta al cliente (todo en una transacción). */
  async transition(actor: AuthUser, id: string, to: DisbursementStatus, note?: string, opts: { notifyClient?: boolean } = {}) {
    const result = await this.prisma.$transaction(async (tx) => {
      const current = await tx.disbursementRequest.findUnique({ where: { id } });
      if (!current) throw new NotFoundException('Solicitud no encontrada');
      const allowed = actor.role === Role.CLIENT ? current.status === 'PENDING' && to === 'CANCELLED' : TRANSITIONS[current.status].includes(to);
      if (!allowed) {
        throw new ConflictException(`No se puede pasar de "${STATUS_LABELS[current.status]}" a "${STATUS_LABELS[to]}"`);
      }
      if (to === 'REJECTED' && !note?.trim()) throw new BadRequestException('Indica el motivo del rechazo');

      const updated = await tx.disbursementRequest.update({
        where: { id },
        data: {
          status: to,
          adminNote: note?.trim() || current.adminNote,
          disbursedAt: to === 'DISBURSED' ? new Date() : current.disbursedAt,
          events: { create: { fromStatus: current.status, toStatus: to, note: note?.trim() || null, actorId: actor.id, actorName: actor.fullName } },
        },
      });
      await this.audit.log({ actor, action: 'DISBURSEMENT_STATUS', entity: 'DisbursementRequest', entityId: id, metadata: { code: updated.code, from: current.status, to } }, tx);
      return updated;
    });

    if (opts.notifyClient !== false) {
      await this.notifications.notify(result.clientId, {
        type: 'DISBURSEMENT',
        title: `Solicitud ${result.code}: ${STATUS_LABELS[to].toLowerCase()}`,
        body: note?.trim() ? `Tu solicitud cambió a "${STATUS_LABELS[to]}". ${note.trim()}` : `Tu solicitud cambió a "${STATUS_LABELS[to]}".`,
        link: `/dashboard/desembolsos/${result.id}`,
      });
    }
    return result;
  }

  async listForStaff(q: { status?: DisbursementStatus; search?: string; clientId?: string }, skip: number, take: number) {
    const where: Prisma.DisbursementRequestWhereInput = {
      ...(q.status ? { status: q.status } : {}),
      ...(q.clientId ? { clientId: q.clientId } : {}),
      ...(q.search
        ? { OR: [{ code: { contains: q.search, mode: 'insensitive' } }, { client: { fullName: { contains: q.search, mode: 'insensitive' } } }, { client: { email: { contains: q.search, mode: 'insensitive' } } }] }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.disbursementRequest.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip,
        take,
        include: { client: { select: { id: true, fullName: true, email: true } }, _count: { select: { documents: true } } },
      }),
      this.prisma.disbursementRequest.count({ where }),
    ]);
    return { items, total };
  }
}
