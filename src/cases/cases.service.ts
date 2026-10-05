import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CaseStage, CaseStatus, DocumentCategory, DocumentStatus, Prisma, Role, UserStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/types';
import { CATEGORY_LABELS } from '../documents/documents.service';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

export const STAGE_ORDER: CaseStage[] = ['INTAKE', 'DOCUMENT_REVIEW', 'LEGAL_ANALYSIS', 'NEGOTIATION', 'RECOVERY', 'DISBURSEMENT', 'CLOSED'];
export const STAGE_LABELS: Record<CaseStage, string> = {
  INTAKE: 'Recepción del caso',
  DOCUMENT_REVIEW: 'Revisión de documentos',
  LEGAL_ANALYSIS: 'Análisis jurídico',
  NEGOTIATION: 'Negociación',
  RECOVERY: 'Recuperación',
  DISBURSEMENT: 'Desembolso',
  CLOSED: 'Caso cerrado',
};
const STATUS_LABELS: Record<CaseStatus, string> = {
  OPEN: 'Abierto',
  IN_PROGRESS: 'En curso',
  WAITING_CLIENT: 'A la espera del cliente',
  CLOSED: 'Cerrado',
};

type RequirementState = 'VALIDATED' | 'PENDING' | 'REJECTED' | 'MISSING';
const RANK: Record<RequirementState, number> = { VALIDATED: 3, PENDING: 2, REJECTED: 1, MISSING: 0 };

export type CreateCaseInput = {
  clientId: string;
  lawyerId?: string;
  title: string;
  description?: string;
  amountClaimed?: number;
  nextSteps?: string;
  requirements?: { label: string; category: DocumentCategory }[];
};

export type UpdateCaseInput = {
  title?: string;
  description?: string;
  lawyerId?: string;
  status?: CaseStatus;
  stage?: CaseStage;
  nextSteps?: string;
  amountClaimed?: number;
};

@Injectable()
export class CasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  /** Un abogado solo ve sus casos asignados; el superadmin ve todos. */
  private scope(actor: AuthUser): Prisma.CaseWhereInput {
    return actor.role === Role.SUPERADMIN ? {} : { lawyerId: actor.id };
  }

  private async requirementStates(clientId: string, requirements: { id: string; label: string; category: DocumentCategory }[]) {
    if (!requirements.length) return [];
    const docs = await this.prisma.document.findMany({ where: { ownerId: clientId }, select: { category: true, status: true } });
    return requirements.map((req) => {
      let state: RequirementState = 'MISSING';
      for (const d of docs.filter((x) => x.category === req.category)) {
        const s: RequirementState = d.status === DocumentStatus.VALIDATED ? 'VALIDATED' : d.status === DocumentStatus.PENDING ? 'PENDING' : 'REJECTED';
        if (RANK[s] > RANK[state]) state = s;
      }
      return { ...req, categoryLabel: CATEGORY_LABELS[req.category], state };
    });
  }

  // ---- Cliente ----

  async listOwn(clientId: string) {
    const cases = await this.prisma.case.findMany({
      where: { clientId },
      orderBy: { updatedAt: 'desc' },
      include: { lawyer: { select: { fullName: true } } },
    });
    return cases.map((c) => ({ ...c, progress: Math.round((STAGE_ORDER.indexOf(c.stage) / (STAGE_ORDER.length - 1)) * 100) }));
  }

  async detailOwn(clientId: string, id: string) {
    const found = await this.prisma.case.findFirst({
      where: { id, clientId },
      include: {
        lawyer: { select: { fullName: true, email: true } },
        requirements: true,
        events: { orderBy: { createdAt: 'asc' } },
        disbursements: { select: { id: true, code: true, amount: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!found) throw new NotFoundException('Caso no encontrado');
    return { ...found, requirements: await this.requirementStates(clientId, found.requirements) };
  }

  // ---- Personal ----

  async listForStaff(actor: AuthUser, q: { status?: CaseStatus; stage?: CaseStage; search?: string; clientId?: string }, skip: number, take: number) {
    const where: Prisma.CaseWhereInput = {
      ...this.scope(actor),
      ...(q.status ? { status: q.status } : {}),
      ...(q.stage ? { stage: q.stage } : {}),
      ...(q.clientId ? { clientId: q.clientId } : {}),
      ...(q.search
        ? { OR: [{ number: { contains: q.search, mode: 'insensitive' } }, { title: { contains: q.search, mode: 'insensitive' } }, { client: { fullName: { contains: q.search, mode: 'insensitive' } } }] }
        : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.case.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip,
        take,
        include: { client: { select: { id: true, fullName: true, email: true } }, lawyer: { select: { id: true, fullName: true } } },
      }),
      this.prisma.case.count({ where }),
    ]);
    return { items, total };
  }

  async detailForStaff(actor: AuthUser, id: string) {
    const found = await this.prisma.case.findFirst({
      where: { id, ...this.scope(actor) },
      include: {
        client: { select: { id: true, fullName: true, email: true } },
        lawyer: { select: { id: true, fullName: true } },
        requirements: true,
        events: { orderBy: { createdAt: 'asc' } },
        disbursements: { select: { id: true, code: true, amount: true, status: true, createdAt: true }, orderBy: { createdAt: 'desc' } },
      },
    });
    if (!found) throw new NotFoundException('Caso no encontrado');
    return { ...found, requirements: await this.requirementStates(found.clientId, found.requirements) };
  }

  private async assertAssignable(actor: AuthUser, lawyerId: string | null | undefined) {
    if (!lawyerId) return;
    if (actor.role !== Role.SUPERADMIN && lawyerId !== actor.id) {
      throw new ForbiddenException('Solo el superadmin puede asignar casos a otro abogado');
    }
    const lawyer = await this.prisma.user.findFirst({ where: { id: lawyerId, role: { in: [Role.LAWYER, Role.SUPERADMIN] }, status: UserStatus.ACTIVE }, select: { id: true } });
    if (!lawyer) throw new BadRequestException('El abogado indicado no existe o está inactivo');
  }

  async create(actor: AuthUser, input: CreateCaseInput) {
    const client = await this.prisma.user.findFirst({ where: { id: input.clientId, role: Role.CLIENT, status: UserStatus.ACTIVE }, select: { id: true } });
    if (!client) throw new BadRequestException('El cliente indicado no existe o está inactivo');
    const lawyerId = input.lawyerId || (actor.role === Role.LAWYER ? actor.id : undefined);
    await this.assertAssignable(actor, lawyerId);

    const created = await this.prisma.$transaction(async (tx) => {
      const number = await this.prisma.nextCode('CAS', tx);
      const row = await tx.case.create({
        data: {
          number,
          clientId: input.clientId,
          lawyerId,
          title: input.title.trim(),
          description: input.description?.trim(),
          amountClaimed: input.amountClaimed,
          currency: this.config.get<string>('DEFAULT_CURRENCY') ?? 'USD',
          nextSteps: input.nextSteps?.trim(),
          requirements: { create: input.requirements ?? [] },
          events: { create: { stage: 'INTAKE', title: 'Caso abierto', description: 'Hemos recibido tu caso y comenzamos el proceso.', actorName: actor.fullName } },
        },
        include: { requirements: true },
      });
      await this.audit.log({ actor, action: 'CASE_CREATED', entity: 'Case', entityId: row.id, metadata: { number, clientId: input.clientId } }, tx);
      return row;
    });

    await this.notifications.notify(created.clientId, { type: 'CASE', title: `Se abrió tu caso ${created.number}`, body: created.title, link: `/dashboard/casos/${created.id}` });
    const states = await this.requirementStates(created.clientId, created.requirements);
    const missing = states.filter((s) => s.state === 'MISSING' || s.state === 'REJECTED');
    if (missing.length) {
      await this.notifications.notify(created.clientId, {
        type: 'DOCUMENT',
        title: `Documentos requeridos para el caso ${created.number}`,
        body: `Necesitamos: ${missing.map((m) => m.label).join(', ')}.`,
        link: '/dashboard/documentos',
      });
    }
    return this.detailForStaff(actor, created.id);
  }

  async update(actor: AuthUser, id: string, input: UpdateCaseInput) {
    const current = await this.prisma.case.findFirst({ where: { id, ...this.scope(actor) } });
    if (!current) throw new NotFoundException('Caso no encontrado');
    // Cadena vacía = quitar la asignación.
    const nextLawyerId = input.lawyerId === undefined ? undefined : input.lawyerId || null;
    if (nextLawyerId !== undefined && nextLawyerId !== current.lawyerId) await this.assertAssignable(actor, nextLawyerId);

    const data: Prisma.CaseUncheckedUpdateInput = {};
    if (input.title !== undefined) data.title = input.title.trim();
    if (input.description !== undefined) data.description = input.description.trim();
    if (input.nextSteps !== undefined) data.nextSteps = input.nextSteps.trim();
    if (input.amountClaimed !== undefined) data.amountClaimed = input.amountClaimed;
    if (nextLawyerId !== undefined) data.lawyerId = nextLawyerId;

    let stage = input.stage ?? current.stage;
    let status = input.status ?? current.status;
    // Etapa y estado "cerrado" siempre van de la mano.
    if (input.stage === 'CLOSED') status = 'CLOSED';
    if (input.status === 'CLOSED') stage = 'CLOSED';
    if (status === 'CLOSED' && input.stage && input.stage !== 'CLOSED') {
      throw new BadRequestException('Un caso cerrado no puede volver a una etapa anterior; cambia primero su estado');
    }
    data.stage = stage;
    data.status = status;

    const stageChanged = stage !== current.stage;
    const statusChanged = status !== current.status;

    await this.prisma.$transaction(async (tx) => {
      await tx.case.update({ where: { id }, data });
      if (stageChanged) {
        await tx.caseEvent.create({ data: { caseId: id, stage, title: `Etapa: ${STAGE_LABELS[stage]}`, description: input.nextSteps?.trim() || null, actorName: actor.fullName } });
      }
      await this.audit.log({ actor, action: 'CASE_UPDATED', entity: 'Case', entityId: id, metadata: { number: current.number, stage: { from: current.stage, to: stage }, status: { from: current.status, to: status } } }, tx);
    });

    if (stageChanged || statusChanged || input.nextSteps !== undefined) {
      const parts: string[] = [];
      if (stageChanged) parts.push(`Nueva etapa: ${STAGE_LABELS[stage]}.`);
      if (statusChanged) parts.push(`Estado: ${STATUS_LABELS[status]}.`);
      if (input.nextSteps?.trim()) parts.push(`Próximos pasos: ${input.nextSteps.trim()}`);
      await this.notifications.notify(current.clientId, { type: 'CASE', title: `Actualización del caso ${current.number}`, body: parts.join(' '), link: `/dashboard/casos/${id}` });
    }
    return this.detailForStaff(actor, id);
  }

  async addEvent(actor: AuthUser, id: string, input: { title: string; description?: string }) {
    const current = await this.prisma.case.findFirst({ where: { id, ...this.scope(actor) } });
    if (!current) throw new NotFoundException('Caso no encontrado');
    await this.prisma.caseEvent.create({ data: { caseId: id, stage: current.stage, title: input.title.trim(), description: input.description?.trim(), actorName: actor.fullName } });
    await this.prisma.case.update({ where: { id }, data: { updatedAt: new Date() } });
    await this.audit.log({ actor, action: 'CASE_EVENT_ADDED', entity: 'Case', entityId: id, metadata: { title: input.title } });
    await this.notifications.notify(current.clientId, { type: 'CASE', title: `Novedad en el caso ${current.number}`, body: input.title.trim(), link: `/dashboard/casos/${id}` });
    return this.detailForStaff(actor, id);
  }

  async addRequirement(actor: AuthUser, id: string, input: { label: string; category: DocumentCategory }) {
    const current = await this.prisma.case.findFirst({ where: { id, ...this.scope(actor) } });
    if (!current) throw new NotFoundException('Caso no encontrado');
    await this.prisma.caseRequirement.create({ data: { caseId: id, label: input.label.trim(), category: input.category } });
    await this.notifications.notify(current.clientId, {
      type: 'DOCUMENT',
      title: `Nuevo documento requerido (${current.number})`,
      body: `${input.label.trim()} — ${CATEGORY_LABELS[input.category]}.`,
      link: '/dashboard/documentos',
    });
    return this.detailForStaff(actor, id);
  }

  async removeRequirement(actor: AuthUser, id: string, requirementId: string) {
    const current = await this.prisma.case.findFirst({ where: { id, ...this.scope(actor) }, select: { id: true } });
    if (!current) throw new NotFoundException('Caso no encontrado');
    await this.prisma.caseRequirement.deleteMany({ where: { id: requirementId, caseId: id } });
    return this.detailForStaff(actor, id);
  }
}
