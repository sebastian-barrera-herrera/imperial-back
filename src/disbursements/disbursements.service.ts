import { BadRequestException, ConflictException, Injectable, NotFoundException, StreamableFile, UnprocessableEntityException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApprovalDocument, DisbursementStatus, DocumentStatus, Prisma, Role, UserStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { CryptoService } from '../common/crypto.service';
import { AuthUser } from '../common/types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { renderApprovalPdf } from './approval-pdf';
import { codesMatch, documentFingerprint, verificationCode, type DocumentFields } from './verification';

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
  approvalDocument: { select: { releasedAt: true } },
} satisfies Prisma.DisbursementRequestInclude;

@Injectable()
export class DisbursementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
    private readonly crypto: CryptoService,
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
    const { approvalDocument, ...rest } = request;
    // El cliente solo ve el botón de descarga cuando el superadmin habilitó el documento.
    return { ...rest, approvalPdfAvailable: DisbursementsService.APPROVED_STATES.includes(request.status) && !!approvalDocument?.releasedAt };
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

  // ───────────── Documento de aprobación (PDF) ─────────────

  /** El PDF solo existe para solicitudes aprobadas (o más avanzadas): es la constancia de la aprobación. */
  static readonly APPROVED_STATES: DisbursementStatus[] = ['APPROVED', 'IN_PROCESS', 'DISBURSED'];

  private get timeZone() {
    return this.config.get<string>('APP_TIMEZONE') ?? 'America/New_York';
  }

  private get issuePlace() {
    return this.config.get<string>('DOC_ISSUE_PLACE') ?? 'Miami, Florida, EE. UU.';
  }

  /** AAAA-MM-DD de un instante en la zona horaria del despacho. */
  private ymd(date: Date): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  }

  /** Valores por defecto del documento, tomados de la solicitud; el superadmin puede cambiarlos. */
  private defaultFields(r: { bankName: string | null; accountLast4: string | null; createdAt: Date }): DocumentFields {
    return {
      issuerName: 'Imperial Law Group — Equipo jurídico', signerName: null, signerTitle: null, financialEntity: r.bankName ?? '',
      accountLast4: r.accountLast4, requestDate: this.ymd(r.createdAt), issuePlace: this.issuePlace, notes: null,
    };
  }

  private fieldsOf(r: { bankName: string | null; accountLast4: string | null; createdAt: Date }, doc: ApprovalDocument | null): DocumentFields {
    if (!doc) return this.defaultFields(r);
    return {
      issuerName: doc.issuerName, signerName: doc.signerName, signerTitle: doc.signerTitle, financialEntity: doc.financialEntity,
      accountLast4: doc.accountLast4, requestDate: doc.requestDate.toISOString().slice(0, 10), issuePlace: doc.issuePlace, notes: doc.notes,
    };
  }

  private async approvalSubject(id: string, clientId: string | null) {
    const request = await this.prisma.disbursementRequest.findFirst({
      where: { id, ...(clientId ? { clientId } : {}) },
      include: {
        events: { orderBy: { createdAt: 'asc' } },
        case: { select: { number: true } },
        approvalDocument: true,
        client: { select: { id: true, fullName: true, email: true, profile: { select: { cedulaEnc: true } } } },
      },
    });
    if (!request) throw new NotFoundException('Solicitud no encontrada');
    if (!DisbursementsService.APPROVED_STATES.includes(request.status)) {
      throw new ConflictException('El documento de aprobación solo está disponible para solicitudes aprobadas');
    }
    const approval = request.events.find((e) => e.toStatus === 'APPROVED');
    if (!approval) throw new ConflictException('La solicitud no tiene registrada su aprobación');
    const fields = this.fieldsOf(request, request.approvalDocument);
    const code = verificationCode(this.config.getOrThrow<string>('JWT_SECRET'), {
      reference: request.code, amount: request.amount.toFixed(2), currency: request.currency, approvedAt: approval.createdAt, clientId: request.clientId, fields,
    });
    return { request, approval, code, fields, released: !!request.approvalDocument?.releasedAt };
  }

  async approvalPdf(user: AuthUser, id: string) {
    const isClient = user.role === Role.CLIENT;
    const { request, approval, code, fields, released } = await this.approvalSubject(id, isClient ? user.id : null);
    if (isClient && !released) throw new ConflictException('El despacho aún no ha habilitado este documento. Te avisaremos cuando esté disponible');
    const site = (this.config.get<string>('PUBLIC_SITE_URL') ?? 'http://localhost:3000').replace(/\/+$/, '');
    let idMasked: string | null = null;
    const enc = request.client.profile?.cedulaEnc;
    if (enc) {
      try {
        const plain = this.crypto.decrypt(enc);
        idMasked = plain.length > 4 ? `${'•'.repeat(Math.min(plain.length - 4, 8))}${plain.slice(-4)}` : null;
      } catch {
        idMasked = null;
      }
    }
    const buffer = await renderApprovalPdf({
      reference: request.code,
      issuedAt: new Date(),
      requestDate: new Date(`${fields.requestDate}T00:00:00Z`),
      approvedAt: approval.createdAt,
      approvedBy: approval.actorName,
      issuerName: fields.issuerName,
      issuePlace: fields.issuePlace,
      signerName: fields.signerName,
      signerTitle: fields.signerTitle,
      notes: fields.notes,
      draft: !released,
      statusLabel: STATUS_LABELS[request.status],
      amount: Number(request.amount),
      currency: request.currency,
      concept: request.concept,
      beneficiary: { name: request.client.fullName, email: request.client.email, idMasked },
      bank: { name: fields.financialEntity, last4: fields.accountLast4 },
      caseNumber: request.case?.number,
      events: request.events.map((e) => ({ at: e.createdAt, status: STATUS_LABELS[e.toStatus], note: e.note, by: e.actorName })),
      verification: { code, url: `${site}/verificar?ref=${encodeURIComponent(request.code)}&code=${code}` },
      timeZone: this.timeZone,
    });
    if (!isClient) {
      await this.audit.log({ actor: user, action: 'DISBURSEMENT_APPROVAL_PDF_DOWNLOADED', entity: 'DisbursementRequest', entityId: request.id, metadata: { code: request.code, draft: !released } });
    }
    return new StreamableFile(buffer, { type: 'application/pdf', length: buffer.length, disposition: `attachment; filename="${released ? 'Aprobacion' : 'Borrador-Aprobacion'}-${request.code}.pdf"` });
  }

  // ───────────── Datos del documento (los define el superadmin) ─────────────

  async approvalDocumentView(id: string) {
    const r = await this.prisma.disbursementRequest.findUnique({ where: { id }, include: { approvalDocument: true, events: { orderBy: { createdAt: 'asc' } } } });
    if (!r) throw new NotFoundException('Solicitud no encontrada');
    const doc = r.approvalDocument;
    const approval = r.events.find((e) => e.toStatus === 'APPROVED');
    return {
      eligible: DisbursementsService.APPROVED_STATES.includes(r.status) && !!approval,
      configured: !!doc,
      released: !!doc?.releasedAt,
      releasedAt: doc?.releasedAt ?? null,
      releasedBy: doc?.releasedBy ?? null,
      updatedAt: doc?.updatedAt ?? null,
      updatedBy: doc?.updatedBy ?? null,
      approvedAt: approval?.createdAt ?? null,
      approvedOn: approval ? this.ymd(approval.createdAt) : null,
      fields: this.fieldsOf(r, doc),
      defaults: this.defaultFields(r),
    };
  }

  async saveApprovalDocument(actor: AuthUser, id: string, dto: { issuerName: string; signerName?: string; signerTitle?: string; financialEntity: string; accountLast4?: string; requestDate: string; issuePlace: string; notes?: string }) {
    const r = await this.prisma.disbursementRequest.findUnique({ where: { id }, include: { approvalDocument: true, events: { orderBy: { createdAt: 'asc' } } } });
    if (!r) throw new NotFoundException('Solicitud no encontrada');
    const approval = r.events.find((e) => e.toStatus === 'APPROVED');
    if (!DisbursementsService.APPROVED_STATES.includes(r.status) || !approval) throw new ConflictException('Solo se puede preparar el documento de una solicitud aprobada');

    const parsed = new Date(`${dto.requestDate}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dto.requestDate) throw new BadRequestException('La fecha de solicitud no es válida');
    const approvedOn = this.ymd(approval.createdAt);
    if (dto.requestDate > approvedOn) throw new BadRequestException(`La fecha de solicitud no puede ser posterior a la fecha de aprobación (${approvedOn})`);

    const before = this.fieldsOf(r, r.approvalDocument);
    const data = {
      issuerName: dto.issuerName, signerName: dto.signerName || null, signerTitle: dto.signerTitle || null, financialEntity: dto.financialEntity,
      accountLast4: dto.accountLast4 || null, requestDate: parsed, issuePlace: dto.issuePlace, notes: dto.notes || null, updatedBy: actor.email,
    };
    await this.prisma.approvalDocument.upsert({ where: { requestId: id }, create: { requestId: id, ...data }, update: data });
    const after = this.fieldsOf(r, { ...data, requestId: id, releasedAt: null, releasedBy: null, updatedAt: new Date() } as ApprovalDocument);
    const changed = (Object.keys(after) as (keyof DocumentFields)[]).filter((k) => after[k] !== before[k]);
    await this.audit.log({ actor, action: 'DISBURSEMENT_DOC_UPDATED', entity: 'DisbursementRequest', entityId: id, metadata: { code: r.code, changed, before: Object.fromEntries(changed.map((k) => [k, before[k]])), after: Object.fromEntries(changed.map((k) => [k, after[k]])), fingerprint: documentFingerprint(after).slice(0, 12) } });
    return this.approvalDocumentView(id);
  }

  /** Habilita (o retira) la descarga del documento para el cliente. Al habilitar, el cliente recibe una alerta. */
  async setApprovalRelease(actor: AuthUser, id: string, release: boolean) {
    const r = await this.prisma.disbursementRequest.findUnique({ where: { id }, include: { approvalDocument: true } });
    if (!r) throw new NotFoundException('Solicitud no encontrada');
    if (!DisbursementsService.APPROVED_STATES.includes(r.status)) throw new ConflictException('Solo se puede habilitar el documento de una solicitud aprobada');
    if (!r.approvalDocument) throw new ConflictException('Primero guarda los datos del documento');
    if (release && r.approvalDocument.releasedAt) throw new ConflictException('El documento ya está habilitado');
    if (!release && !r.approvalDocument.releasedAt) throw new ConflictException('El documento no está habilitado');
    await this.prisma.approvalDocument.update({ where: { requestId: id }, data: { releasedAt: release ? new Date() : null, releasedBy: release ? actor.email : null } });
    await this.audit.log({ actor, action: release ? 'DISBURSEMENT_DOC_RELEASED' : 'DISBURSEMENT_DOC_WITHDRAWN', entity: 'DisbursementRequest', entityId: id, metadata: { code: r.code } });
    if (release) {
      await this.notifications.notify(r.clientId, { type: 'DISBURSEMENT', title: 'Tu documento de aprobación está disponible', body: `${r.code}: ya puedes descargarlo en PDF.`, link: `/dashboard/desembolsos/${r.id}` });
    }
    return this.approvalDocumentView(id);
  }

  /** Comprobación pública (sin sesión) de un documento: solo devuelve datos mínimos, nunca el nombre completo. */
  async verifyApproval(reference: string, code: string) {
    const request = await this.prisma.disbursementRequest.findUnique({ where: { code: reference.trim().toUpperCase() }, select: { id: true } });
    if (request) {
      try {
        const { request: r, approval, code: expected, fields, released } = await this.approvalSubject(request.id, null);
        // Solo los documentos habilitados cuentan como emitidos; un borrador nunca se verifica.
        if (released && codesMatch(code, expected)) {
          const initials = r.client.fullName.split(/\s+/).filter(Boolean).slice(0, 3).map((w) => `${w[0].toUpperCase()}.`).join(' ');
          return {
            valid: true, reference: r.code, status: STATUS_LABELS[r.status], amount: r.amount.toFixed(2), currency: r.currency, approvedAt: approval.createdAt,
            beneficiary: initials, issuer: fields.issuerName, financialEntity: fields.financialEntity, requestDate: fields.requestDate,
          };
        }
      } catch {
        // Solicitud sin aprobación vigente (rechazada/cancelada/pendiente): se informa igual que un código inválido.
      }
    }
    return { valid: false };
  }
}
