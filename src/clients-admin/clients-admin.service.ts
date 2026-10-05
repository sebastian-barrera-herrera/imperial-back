import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Role, UserStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser } from '../common/types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';

const fmtMoney = (amount: number | string, currency: string) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency }).format(Number(amount));

/** Gestión de clientes por el superadmin: baja de acceso, asesor asignado y depósitos. */
@Injectable()
export class ClientsAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
    private readonly config: ConfigService,
  ) {}

  private get currency() {
    return this.config.get<string>('DEFAULT_CURRENCY') ?? 'USD';
  }

  private get timeZone() {
    return this.config.get<string>('APP_TIMEZONE') ?? 'America/New_York';
  }

  private today(): string {
    return new Intl.DateTimeFormat('en-CA', { timeZone: this.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  }

  private async client(id: string) {
    const client = await this.prisma.user.findFirst({ where: { id, role: Role.CLIENT }, select: { id: true, fullName: true, email: true, status: true } });
    if (!client) throw new NotFoundException('Cliente no encontrado');
    return client;
  }

  // ───────────── Baja y reactivación ─────────────

  /** Da de baja al cliente: pierde el acceso al instante (sesiones cerradas) pero se conservan sus datos y su historial. */
  async deactivate(actor: AuthUser, id: string, reason: string) {
    const client = await this.client(id);
    if (client.status === UserStatus.SUSPENDED) throw new ConflictException('El cliente ya está dado de baja');
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id }, data: { status: UserStatus.SUSPENDED, deactivatedAt: new Date(), deactivationReason: reason } }),
      this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } }),
    ]);
    await this.audit.log({ actor, action: 'CLIENT_DEACTIVATED', entity: 'User', entityId: id, metadata: { reason } });
    return { id, status: UserStatus.SUSPENDED, deactivatedAt: new Date(), deactivationReason: reason };
  }

  async reactivate(actor: AuthUser, id: string) {
    const client = await this.client(id);
    if (client.status !== UserStatus.SUSPENDED) throw new ConflictException('El cliente ya tiene acceso');
    await this.prisma.user.update({ where: { id }, data: { status: UserStatus.ACTIVE, deactivatedAt: null, deactivationReason: null } });
    await this.audit.log({ actor, action: 'CLIENT_REACTIVATED', entity: 'User', entityId: id });
    return { id, status: UserStatus.ACTIVE, deactivatedAt: null, deactivationReason: null };
  }

  // ───────────── Asesor profesional ─────────────

  async setAdvisor(actor: AuthUser, id: string, advisorId: string | null) {
    const client = await this.client(id);
    let advisor: { id: string; fullName: string } | null = null;
    if (advisorId) {
      advisor = await this.prisma.user.findFirst({ where: { id: advisorId, role: { in: [Role.LAWYER, Role.SUPERADMIN] }, status: UserStatus.ACTIVE }, select: { id: true, fullName: true } });
      if (!advisor) throw new BadRequestException('El asesor debe ser un abogado o superadmin activo');
    }
    await this.prisma.user.update({ where: { id }, data: { advisorId: advisor?.id ?? null } });
    await this.audit.log({ actor, action: 'CLIENT_ADVISOR_SET', entity: 'User', entityId: id, metadata: { advisorId: advisor?.id ?? null, advisor: advisor?.fullName ?? null } });
    if (advisor) {
      await this.notifications.notify(client.id, { type: 'SYSTEM', title: 'Tu asesor profesional', body: `${advisor.fullName} te atenderá en el despacho.`, link: '/dashboard' });
    }
    return { advisor };
  }

  /** Lo que ve el cliente: su asesor asignado o, si no hay, el abogado de su caso abierto más reciente. */
  async advisorFor(userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { advisor: { select: { fullName: true, status: true } } } });
    if (user?.advisor && user.advisor.status === UserStatus.ACTIVE) return { name: user.advisor.fullName, source: 'assigned' as const };
    const c = await this.prisma.case.findFirst({
      where: { clientId: userId, lawyerId: { not: null }, status: { not: 'CLOSED' } },
      orderBy: { createdAt: 'desc' },
      select: { lawyer: { select: { fullName: true } } },
    });
    return c?.lawyer ? { name: c.lawyer.fullName, source: 'case' as const } : null;
  }

  // ───────────── Depósitos ─────────────

  private present(d: { id: string; amount: { toFixed(n: number): string }; currency: string; depositedAt: Date; reference: string | null; note: string | null; createdAt: Date }) {
    return { id: d.id, amount: d.amount.toFixed(2), currency: d.currency, depositedAt: d.depositedAt.toISOString().slice(0, 10), reference: d.reference, note: d.note, createdAt: d.createdAt };
  }

  private async summary(clientId: string) {
    const [items, sum] = await Promise.all([
      this.prisma.clientDeposit.findMany({ where: { clientId }, orderBy: [{ depositedAt: 'desc' }, { createdAt: 'desc' }] }),
      this.prisma.clientDeposit.aggregate({ where: { clientId }, _sum: { amount: true } }),
    ]);
    return { currency: this.currency, total: sum._sum.amount?.toFixed(2) ?? '0.00', items: items.map((d) => this.present(d)) };
  }

  async listDeposits(clientId: string) {
    const client = await this.client(clientId);
    return { client: { id: client.id, fullName: client.fullName, email: client.email }, ...(await this.summary(clientId)) };
  }

  ownDeposits(userId: string) {
    return this.summary(userId);
  }

  private parseDate(value: string): Date {
    const date = new Date(`${value}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw new BadRequestException('La fecha del depósito no es válida');
    if (value > this.today()) throw new BadRequestException('La fecha del depósito no puede estar en el futuro');
    return date;
  }

  async createDeposit(actor: AuthUser, clientId: string, dto: { amount: number; depositedAt: string; reference?: string; note?: string }) {
    const client = await this.client(clientId);
    const deposit = await this.prisma.clientDeposit.create({
      data: { clientId, amount: dto.amount, currency: this.currency, depositedAt: this.parseDate(dto.depositedAt), reference: dto.reference || null, note: dto.note || null, createdById: actor.id, createdByEmail: actor.email },
    });
    await this.audit.log({ actor, action: 'DEPOSIT_CREATED', entity: 'ClientDeposit', entityId: deposit.id, metadata: { clientId, amount: deposit.amount.toFixed(2), currency: deposit.currency, depositedAt: dto.depositedAt, reference: dto.reference ?? null } });
    await this.notifications.notify(client.id, { type: 'SYSTEM', title: 'Depósito registrado', body: `Se registró un depósito de ${fmtMoney(dto.amount, deposit.currency)} con fecha ${dto.depositedAt}.`, link: '/dashboard/depositos' });
    return this.present(deposit);
  }

  async updateDeposit(actor: AuthUser, id: string, dto: { amount?: number; depositedAt?: string; reference?: string; note?: string }) {
    const current = await this.prisma.clientDeposit.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Depósito no encontrado');
    const updated = await this.prisma.clientDeposit.update({
      where: { id },
      data: {
        amount: dto.amount, depositedAt: dto.depositedAt ? this.parseDate(dto.depositedAt) : undefined,
        reference: dto.reference === undefined ? undefined : dto.reference || null, note: dto.note === undefined ? undefined : dto.note || null,
      },
    });
    await this.audit.log({
      actor, action: 'DEPOSIT_UPDATED', entity: 'ClientDeposit', entityId: id,
      metadata: { clientId: current.clientId, before: { amount: current.amount.toFixed(2), depositedAt: current.depositedAt.toISOString().slice(0, 10), reference: current.reference }, after: { amount: updated.amount.toFixed(2), depositedAt: updated.depositedAt.toISOString().slice(0, 10), reference: updated.reference } },
    });
    return this.present(updated);
  }

  async removeDeposit(actor: AuthUser, id: string) {
    const current = await this.prisma.clientDeposit.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Depósito no encontrado');
    await this.prisma.clientDeposit.delete({ where: { id } });
    await this.audit.log({ actor, action: 'DEPOSIT_DELETED', entity: 'ClientDeposit', entityId: id, metadata: { clientId: current.clientId, amount: current.amount.toFixed(2), depositedAt: current.depositedAt.toISOString().slice(0, 10), reference: current.reference } });
    return { ok: true };
  }
}
