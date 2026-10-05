import { Controller, Get, Query } from '@nestjs/common';
import { Prisma, Role } from '@prisma/client';
import { IsDateString, IsOptional } from 'class-validator';
import { AuditService } from '../audit/audit.service';
import { toCsvFile } from '../common/csv';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/types';
import { CATEGORY_LABELS } from '../documents/documents.service';
import { STATUS_LABELS } from '../disbursements/disbursements.service';
import { STAGE_LABELS } from '../cases/cases.service';
import { InvestmentsService } from '../investments/investments.service';
import { PrismaService } from '../prisma/prisma.service';

class RangeQuery {
  @IsOptional() @IsDateString() from?: string;
  @IsOptional() @IsDateString() to?: string;
}

const MAX_ROWS = 20_000;

/** Reportes CSV del panel. Los de usuarios, auditoría y capital son exclusivos del superadmin. */
@Controller('admin/reports')
@Roles(Role.SUPERADMIN, Role.LAWYER)
export class ReportsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly investments: InvestmentsService,
  ) {}

  private range(q: RangeQuery): { createdAt?: Prisma.DateTimeFilter } {
    if (!q.from && !q.to) return {};
    return { createdAt: { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) } };
  }

  private log(actor: AuthUser, report: string) {
    return this.audit.log({ actor, action: 'REPORT_EXPORTED', entity: 'Report', metadata: { report } });
  }

  @Get('disbursements.csv')
  async disbursements(@CurrentUser() actor: AuthUser, @Query() q: RangeQuery) {
    const rows = await this.prisma.disbursementRequest.findMany({
      where: this.range(q),
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      include: { client: { select: { fullName: true, email: true } }, case: { select: { number: true } } },
    });
    await this.log(actor, 'disbursements');
    return toCsvFile(
      'desembolsos.csv',
      ['Código', 'Fecha', 'Cliente', 'Correo', 'Concepto', 'Monto', 'Moneda', 'Estado', 'Caso', 'Desembolsada el'],
      rows.map((r) => [r.code, r.createdAt, r.client.fullName, r.client.email, r.concept, r.amount.toString(), r.currency, STATUS_LABELS[r.status], r.case?.number ?? '', r.disbursedAt ?? '']),
    );
  }

  @Get('documents.csv')
  async documents(@CurrentUser() actor: AuthUser, @Query() q: RangeQuery) {
    const rows = await this.prisma.document.findMany({
      where: this.range(q),
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      include: { owner: { select: { fullName: true, email: true } }, reviewedBy: { select: { fullName: true } } },
    });
    await this.log(actor, 'documents');
    return toCsvFile(
      'documentos.csv',
      ['Fecha', 'Cliente', 'Correo', 'Categoría', 'Archivo', 'Estado', 'Motivo de rechazo', 'Revisado por', 'Revisado el'],
      rows.map((d) => [d.createdAt, d.owner.fullName, d.owner.email, CATEGORY_LABELS[d.category], d.originalName, d.status, d.rejectionReason ?? '', d.reviewedBy?.fullName ?? '', d.reviewedAt ?? '']),
    );
  }

  @Get('cases.csv')
  async cases(@CurrentUser() actor: AuthUser, @Query() q: RangeQuery) {
    const rows = await this.prisma.case.findMany({
      where: { ...this.range(q), ...(actor.role === Role.SUPERADMIN ? {} : { lawyerId: actor.id }) },
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      include: { client: { select: { fullName: true, email: true } }, lawyer: { select: { fullName: true } } },
    });
    await this.log(actor, 'cases');
    return toCsvFile(
      'casos.csv',
      ['Número', 'Apertura', 'Cliente', 'Correo', 'Título', 'Estado', 'Etapa', 'Monto reclamado', 'Moneda', 'Abogado'],
      rows.map((c) => [c.number, c.createdAt, c.client.fullName, c.client.email, c.title, c.status, STAGE_LABELS[c.stage], c.amountClaimed?.toString() ?? '', c.currency, c.lawyer?.fullName ?? '']),
    );
  }

  @Get('users.csv') @Roles(Role.SUPERADMIN)
  async users(@CurrentUser() actor: AuthUser, @Query() q: RangeQuery) {
    const rows = await this.prisma.user.findMany({ where: this.range(q), orderBy: { createdAt: 'desc' }, take: MAX_ROWS });
    await this.log(actor, 'users');
    return toCsvFile(
      'usuarios.csv',
      ['Nombre', 'Correo', 'Rol', 'Estado', 'Creado', 'Último acceso'],
      rows.map((u) => [u.fullName, u.email, u.role, u.status, u.createdAt, u.lastLoginAt ?? '']),
    );
  }

  @Get('audit.csv') @Roles(Role.SUPERADMIN)
  async auditLog(@CurrentUser() actor: AuthUser, @Query() q: RangeQuery) {
    const rows = await this.prisma.auditLog.findMany({ where: this.range(q), orderBy: { createdAt: 'desc' }, take: MAX_ROWS });
    await this.log(actor, 'audit');
    return toCsvFile(
      'auditoria.csv',
      ['Fecha', 'Usuario', 'Acción', 'Entidad', 'ID', 'IP', 'Detalle'],
      rows.map((a) => [a.createdAt, a.actorEmail ?? '', a.action, a.entity, a.entityId ?? '', a.ip ?? '', a.metadata ? JSON.stringify(a.metadata) : '']),
    );
  }

  @Get('positions.csv') @Roles(Role.SUPERADMIN)
  async positions(@CurrentUser() actor: AuthUser) {
    const rows = await this.investments.listPositions();
    await this.log(actor, 'positions');
    return toCsvFile(
      'inversiones.csv',
      ['Código', 'Cliente', 'Correo', 'Oportunidad', 'Fecha de inversión', 'Capital', 'Unidades', 'Valor unitario de compra', 'Valor unitario actual', 'Valor actual', 'Ganancia', 'Rentabilidad %', 'Anualizado %', 'Estado', 'Rescatada el'],
      rows.map((r) => [r.code, r.user.fullName, r.user.email, r.opportunity.title, r.investedAt, r.amount, r.units, r.unitCost, r.currentUnitValue, r.currentValue, r.pnl, r.returnPct, r.annualizedPct ?? '', r.status === 'ACTIVE' ? 'Activa' : 'Rescatada', r.redeemedAt ?? '']),
    );
  }

  @Get('interests.csv') @Roles(Role.SUPERADMIN)
  async interests(@CurrentUser() actor: AuthUser, @Query() q: RangeQuery) {
    const rows = await this.prisma.opportunityInterest.findMany({
      where: this.range(q),
      orderBy: { createdAt: 'desc' },
      take: MAX_ROWS,
      include: { user: { select: { fullName: true, email: true } }, opportunity: { select: { title: true } } },
    });
    await this.log(actor, 'interests');
    return toCsvFile(
      'interes-capital.csv',
      ['Fecha', 'Cliente', 'Correo', 'Oportunidad', 'Monto', 'Estado', 'Mensaje'],
      rows.map((i) => [i.createdAt, i.user.fullName, i.user.email, i.opportunity.title, i.amount.toString(), i.status, i.message ?? '']),
    );
  }
}
