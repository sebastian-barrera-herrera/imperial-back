import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InterestStatus, InvestmentStatus, OpportunityStatus, Prisma, Role, RiskLevel, UserStatus } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { AuthUser, isStaff } from '../common/types';
import { NotificationsService } from '../notifications/notifications.service';
import { PrismaService } from '../prisma/prisma.service';
import { Point, PositionInput, daysBetween, dayKey, opportunityStats, parseDay, portfolioHistory, positionMetrics, round, valueAt } from './metrics';

export type OpportunityInput = {
  title: string;
  summary: string;
  terms: string;
  minAmount: number;
  maxAmount?: number | null;
  annualRate: number;
  termMonths: number;
  risk: RiskLevel;
  status?: OpportunityStatus;
};

/** Valor unitario con el que nace toda oportunidad (como el precio inicial de una cuota). */
export const INITIAL_UNIT_VALUE = 100;
const SPARKLINE_POINTS = 24;

const today = () => dayKey(new Date());

function assertValidDay(day: string, label: string): string {
  const parsed = parseDay(day);
  if (Number.isNaN(parsed.getTime()) || dayKey(parsed) !== day) throw new BadRequestException(`${label} no es una fecha válida`);
  if (day > today()) throw new BadRequestException(`${label} no puede ser futura`);
  return day;
}

type PositionRow = Prisma.InvestmentGetPayload<{ include: { opportunity: { select: { id: true; title: true; risk: true; status: true } } } }>;
const toInput = (r: { amount: Prisma.Decimal; units: Prisma.Decimal; unitCost: Prisma.Decimal; investedAt: Date; status: InvestmentStatus; redeemedAt: Date | null; redeemedValue: Prisma.Decimal | null }): PositionInput => ({
  amount: Number(r.amount),
  units: Number(r.units),
  unitCost: Number(r.unitCost),
  investedAt: dayKey(r.investedAt),
  status: r.status,
  redeemedAt: r.redeemedAt ? dayKey(r.redeemedAt) : null,
  redeemedValue: r.redeemedValue === null ? null : Number(r.redeemedValue),
});

@Injectable()
export class InvestmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly notifications: NotificationsService,
  ) {}

  // ---------- Series de valoración ----------

  private async seriesFor(opportunityIds: string[]): Promise<Map<string, Point[]>> {
    const map = new Map<string, Point[]>(opportunityIds.map((id) => [id, []]));
    if (!opportunityIds.length) return map;
    const rows = await this.prisma.opportunityValuation.findMany({ where: { opportunityId: { in: opportunityIds } }, orderBy: { date: 'asc' } });
    for (const r of rows) map.get(r.opportunityId)!.push({ date: dayKey(r.date), unitValue: Number(r.unitValue) });
    return map;
  }

  private quote(series: Point[]) {
    const stats = opportunityStats(series, today());
    return {
      latestValue: stats?.latestValue ?? null,
      latestDate: stats?.latestDate ?? null,
      changePct: stats?.changePct ?? null,
      sinceInceptionPct: stats?.sinceInceptionPct ?? null,
      sparkline: series.slice(-SPARKLINE_POINTS),
    };
  }

  // ---------- Cliente: oportunidades ----------

  async listOpen() {
    const opportunities = await this.prisma.investmentOpportunity.findMany({ where: { status: OpportunityStatus.OPEN }, orderBy: { createdAt: 'desc' } });
    const series = await this.seriesFor(opportunities.map((o) => o.id));
    return opportunities.map((o) => ({ ...o, quote: this.quote(series.get(o.id) ?? []) }));
  }

  async getOpen(id: string) {
    const found = await this.prisma.investmentOpportunity.findFirst({ where: { id, status: OpportunityStatus.OPEN } });
    if (!found) throw new NotFoundException('Oportunidad no encontrada');
    return found;
  }

  /** Rendimiento tipo cotización. Un cliente lo ve si la oportunidad está abierta o si tiene una posición en ella. */
  async performance(user: AuthUser, id: string) {
    const opportunity = await this.prisma.investmentOpportunity.findUnique({ where: { id } });
    if (!opportunity) throw new NotFoundException('Oportunidad no encontrada');
    if (!isStaff(user) && opportunity.status !== OpportunityStatus.OPEN) {
      const holds = await this.prisma.investment.count({ where: { userId: user.id, opportunityId: id } });
      if (!holds) throw new NotFoundException('Oportunidad no encontrada');
    }
    const series = (await this.seriesFor([id])).get(id) ?? [];
    return { opportunityId: id, title: opportunity.title, series, stats: opportunityStats(series, today()) };
  }

  async expressInterest(user: AuthUser, opportunityId: string, input: { amount: number; message?: string }) {
    const opportunity = await this.getOpen(opportunityId);
    if (input.amount < Number(opportunity.minAmount)) throw new BadRequestException(`El monto mínimo es ${opportunity.minAmount.toString()}`);
    if (opportunity.maxAmount && input.amount > Number(opportunity.maxAmount)) throw new BadRequestException(`El monto máximo es ${opportunity.maxAmount.toString()}`);
    const pending = await this.prisma.opportunityInterest.findFirst({ where: { opportunityId, userId: user.id, status: InterestStatus.PENDING }, select: { id: true } });
    if (pending) throw new ConflictException('Ya tienes una solicitud de participación pendiente en esta oportunidad');

    const interest = await this.prisma.opportunityInterest.create({
      data: { opportunityId, userId: user.id, amount: input.amount, message: input.message?.trim() },
    });
    await this.audit.log({ actor: user, action: 'INTEREST_CREATED', entity: 'OpportunityInterest', entityId: interest.id, metadata: { opportunityId, amount: input.amount } });
    const admins = await this.prisma.user.findMany({ where: { role: Role.SUPERADMIN, status: UserStatus.ACTIVE }, select: { id: true } });
    await this.notifications.notifyMany(admins.map((a) => a.id), {
      type: 'OPPORTUNITY',
      title: 'Nuevo interés en una oportunidad',
      body: `${user.fullName} quiere participar en "${opportunity.title}".`,
      link: '/admin/capital',
    });
    return interest;
  }

  listOwnInterests(userId: string) {
    return this.prisma.opportunityInterest.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      include: { opportunity: { select: { id: true, title: true } } },
    });
  }

  // ---------- Cliente: portafolio ----------

  private async buildPositions(rows: PositionRow[]) {
    const now = today();
    const series = await this.seriesFor([...new Set(rows.map((r) => r.opportunityId))]);
    return rows.map((r) => {
      const input = toInput(r);
      const opportunitySeries = series.get(r.opportunityId) ?? [];
      return {
        row: r,
        input,
        series: opportunitySeries,
        metrics: positionMetrics(input, opportunitySeries, now),
      };
    });
  }

  async portfolio(userId: string) {
    const rows = await this.prisma.investment.findMany({
      where: { userId },
      include: { opportunity: { select: { id: true, title: true, risk: true, status: true } } },
      orderBy: [{ investedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const built = await this.buildPositions(rows);
    const now = today();

    const positions = built.map(({ row, input, series, metrics }) => ({
      id: row.id,
      code: row.code,
      opportunity: row.opportunity,
      amount: input.amount,
      units: input.units,
      unitCost: input.unitCost,
      investedAt: input.investedAt,
      status: row.status,
      redeemedAt: input.redeemedAt,
      redeemedValue: input.redeemedValue,
      ...metrics,
      sparkline: series.filter((p) => p.date >= input.investedAt && (!input.redeemedAt || p.date <= input.redeemedAt)).slice(-SPARKLINE_POINTS),
    }));

    const active = built.filter((b) => b.input.status === 'ACTIVE');
    const invested = active.reduce((s, b) => s + b.input.amount, 0);
    const currentValue = active.reduce((s, b) => s + b.metrics.currentValue, 0);
    const weightedDays = invested > 0 ? active.reduce((s, b) => s + b.input.amount * b.metrics.daysHeld, 0) / invested : 0;
    const realizedPnl = built.filter((b) => b.input.status === 'REDEEMED').reduce((s, b) => s + b.metrics.pnl, 0);

    // Último cambio de valoración sobre lo que ya se tenía antes de ese cambio (como la variación del día en bolsa).
    let changeAmount = 0;
    let changeBase = 0;
    let asOf: string | null = null;
    for (const b of active) {
      const s = b.series;
      if (s.length < 2) continue;
      const latest = s[s.length - 1];
      const previous = s[s.length - 2];
      if (b.input.investedAt > previous.date) continue;
      changeAmount += b.input.units * (latest.unitValue - previous.unitValue);
      changeBase += b.input.units * previous.unitValue;
      if (!asOf || latest.date > asOf) asOf = latest.date;
    }

    const byOpportunity = new Map<string, { opportunityId: string; title: string; value: number }>();
    for (const b of active) {
      const entry = byOpportunity.get(b.row.opportunityId) ?? { opportunityId: b.row.opportunityId, title: b.row.opportunity.title, value: 0 };
      entry.value += b.metrics.currentValue;
      byOpportunity.set(b.row.opportunityId, entry);
    }

    const seriesByOpp = new Map(built.map((b) => [b.row.opportunityId, b.series]));
    return {
      currency: 'USD',
      asOf: now,
      summary: {
        activePositions: active.length,
        invested: round(invested),
        currentValue: round(currentValue),
        unrealizedPnl: round(currentValue - invested),
        returnPct: invested > 0 ? round(((currentValue - invested) / invested) * 100) : 0,
        annualizedPct: invested > 0 && weightedDays >= 30 && currentValue > 0 ? round((Math.pow(currentValue / invested, 365 / weightedDays) - 1) * 100) : null,
        realizedPnl: round(realizedPnl),
        lastChange: asOf && changeBase > 0 ? { amount: round(changeAmount), pct: round((changeAmount / changeBase) * 100), asOf } : null,
      },
      allocation: [...byOpportunity.values()]
        .sort((a, b) => b.value - a.value)
        .map((e) => ({ ...e, value: round(e.value), sharePct: currentValue > 0 ? round((e.value / currentValue) * 100, 1) : 0 })),
      history: portfolioHistory(built.map((b) => ({ ...b.input, opportunityId: b.row.opportunityId })), seriesByOpp, now),
      positions,
    };
  }

  // ---------- Superadmin: oportunidades ----------

  async listAll() {
    const rows = await this.prisma.investmentOpportunity.findMany({ orderBy: { createdAt: 'desc' }, include: { _count: { select: { interests: true, investments: true } } } });
    const series = await this.seriesFor(rows.map((o) => o.id));
    return rows.map((o) => ({ ...o, quote: this.quote(series.get(o.id) ?? []) }));
  }

  private validateRange(input: Pick<OpportunityInput, 'minAmount' | 'maxAmount'>) {
    if (input.maxAmount != null && input.maxAmount < input.minAmount) throw new BadRequestException('El monto máximo no puede ser menor al mínimo');
  }

  async create(actor: AuthUser, input: OpportunityInput) {
    this.validateRange(input);
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.investmentOpportunity.create({ data: { ...input, status: input.status ?? OpportunityStatus.DRAFT } });
      // Toda oportunidad arranca con su valor unitario inicial: es el punto de partida de la serie.
      await tx.opportunityValuation.create({ data: { opportunityId: row.id, date: parseDay(today()), unitValue: INITIAL_UNIT_VALUE, note: 'Valor inicial' } });
      return row;
    });
    await this.audit.log({ actor, action: 'OPPORTUNITY_CREATED', entity: 'InvestmentOpportunity', entityId: created.id, metadata: { title: created.title, status: created.status } });
    if (created.status === OpportunityStatus.OPEN) await this.announce(created.id, created.title);
    return created;
  }

  async update(actor: AuthUser, id: string, input: Partial<OpportunityInput>) {
    const current = await this.prisma.investmentOpportunity.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Oportunidad no encontrada');
    this.validateRange({ minAmount: input.minAmount ?? Number(current.minAmount), maxAmount: input.maxAmount === undefined ? (current.maxAmount ? Number(current.maxAmount) : null) : input.maxAmount });
    const updated = await this.prisma.investmentOpportunity.update({ where: { id }, data: input as Prisma.InvestmentOpportunityUpdateInput });
    await this.audit.log({ actor, action: 'OPPORTUNITY_UPDATED', entity: 'InvestmentOpportunity', entityId: id, metadata: { from: current.status, to: updated.status } });
    if (current.status !== OpportunityStatus.OPEN && updated.status === OpportunityStatus.OPEN) await this.announce(id, updated.title);
    return updated;
  }

  async remove(actor: AuthUser, id: string) {
    const current = await this.prisma.investmentOpportunity.findUnique({ where: { id }, include: { _count: { select: { interests: true, investments: true } } } });
    if (!current) throw new NotFoundException('Oportunidad no encontrada');
    if (current._count.investments > 0) throw new ConflictException('Tiene inversiones registradas; ciérrala en lugar de eliminarla');
    if (current._count.interests > 0) throw new ConflictException('Tiene solicitudes de participación asociadas; ciérrala en lugar de eliminarla');
    await this.prisma.investmentOpportunity.delete({ where: { id } });
    await this.audit.log({ actor, action: 'OPPORTUNITY_DELETED', entity: 'InvestmentOpportunity', entityId: id, metadata: { title: current.title } });
    return { ok: true };
  }

  listInterests(status?: InterestStatus) {
    return this.prisma.opportunityInterest.findMany({
      where: status ? { status } : {},
      orderBy: { createdAt: 'desc' },
      include: { opportunity: { select: { id: true, title: true } }, user: { select: { id: true, fullName: true, email: true } } },
    });
  }

  async setInterestStatus(actor: AuthUser, id: string, status: InterestStatus) {
    const current = await this.prisma.opportunityInterest.findUnique({ where: { id } });
    if (!current) throw new NotFoundException('Solicitud no encontrada');
    const updated = await this.prisma.opportunityInterest.update({ where: { id }, data: { status } });
    await this.audit.log({ actor, action: 'INTEREST_STATUS', entity: 'OpportunityInterest', entityId: id, metadata: { from: current.status, to: status } });
    return updated;
  }

  // ---------- Superadmin: valoraciones ----------

  async listValuations(opportunityId: string) {
    const opportunity = await this.prisma.investmentOpportunity.findUnique({ where: { id: opportunityId }, select: { id: true } });
    if (!opportunity) throw new NotFoundException('Oportunidad no encontrada');
    const rows = await this.prisma.opportunityValuation.findMany({ where: { opportunityId }, orderBy: { date: 'desc' } });
    return rows.map((r) => ({ id: r.id, date: dayKey(r.date), unitValue: Number(r.unitValue), note: r.note }));
  }

  /** Registra (o corrige) el valor unitario de una fecha y avisa a quienes tienen posiciones abiertas si es la valoración más reciente. */
  async addValuation(actor: AuthUser, opportunityId: string, input: { date: string; unitValue: number; note?: string }) {
    const opportunity = await this.prisma.investmentOpportunity.findUnique({ where: { id: opportunityId } });
    if (!opportunity) throw new NotFoundException('Oportunidad no encontrada');
    const day = assertValidDay(input.date, 'La fecha de valoración');
    const before = (await this.seriesFor([opportunityId])).get(opportunityId) ?? [];
    const previous = [...before].reverse().find((p) => p.date < day) ?? null;
    const isLatest = before.every((p) => p.date <= day);

    await this.prisma.opportunityValuation.upsert({
      where: { opportunityId_date: { opportunityId, date: parseDay(day) } },
      create: { opportunityId, date: parseDay(day), unitValue: input.unitValue, note: input.note?.trim() || null },
      update: { unitValue: input.unitValue, note: input.note?.trim() || null },
    });
    await this.audit.log({ actor, action: 'VALUATION_SET', entity: 'InvestmentOpportunity', entityId: opportunityId, metadata: { date: day, unitValue: input.unitValue } });

    if (isLatest) {
      const holders = await this.prisma.investment.findMany({ where: { opportunityId, status: InvestmentStatus.ACTIVE }, select: { userId: true }, distinct: ['userId'] });
      const change = previous ? ((input.unitValue / previous.unitValue - 1) * 100) : null;
      await this.notifications.notifyMany(holders.map((h) => h.userId), {
        type: 'OPPORTUNITY',
        title: `Nueva valoración: ${opportunity.title}`,
        body: change === null ? `Valor por unidad: ${input.unitValue}.` : `Valor por unidad: ${input.unitValue} (${change >= 0 ? '+' : '−'}${Math.abs(change).toFixed(2)}% vs. la valoración anterior).`,
        link: '/dashboard/inversiones',
      });
    }
    return this.listValuations(opportunityId);
  }

  async removeValuation(actor: AuthUser, opportunityId: string, valuationId: string) {
    const rows = await this.prisma.opportunityValuation.findMany({ where: { opportunityId }, orderBy: { date: 'asc' } });
    const target = rows.find((r) => r.id === valuationId);
    if (!target) throw new NotFoundException('Valoración no encontrada');
    if (rows[0].id === valuationId) throw new ConflictException('No se puede eliminar la valoración inicial de la oportunidad');
    await this.prisma.opportunityValuation.delete({ where: { id: valuationId } });
    await this.audit.log({ actor, action: 'VALUATION_DELETED', entity: 'InvestmentOpportunity', entityId: opportunityId, metadata: { date: dayKey(target.date) } });
    return this.listValuations(opportunityId);
  }

  // ---------- Superadmin: posiciones ----------

  async createPosition(actor: AuthUser, input: { userId: string; opportunityId: string; amount: number; investedAt?: string }) {
    const client = await this.prisma.user.findFirst({ where: { id: input.userId, role: Role.CLIENT, status: UserStatus.ACTIVE }, select: { id: true, fullName: true } });
    if (!client) throw new BadRequestException('El cliente indicado no existe o está inactivo');
    const opportunity = await this.prisma.investmentOpportunity.findUnique({ where: { id: input.opportunityId } });
    if (!opportunity) throw new NotFoundException('Oportunidad no encontrada');
    if (opportunity.status === OpportunityStatus.DRAFT) throw new BadRequestException('La oportunidad aún es un borrador; ábrela antes de registrar inversiones');
    if (input.amount < Number(opportunity.minAmount)) throw new BadRequestException(`El monto mínimo es ${opportunity.minAmount.toString()}`);
    if (opportunity.maxAmount && input.amount > Number(opportunity.maxAmount)) throw new BadRequestException(`El monto máximo es ${opportunity.maxAmount.toString()}`);

    const day = assertValidDay(input.investedAt ?? today(), 'La fecha de inversión');
    const series = (await this.seriesFor([opportunity.id])).get(opportunity.id) ?? [];
    const unitCost = valueAt(series, day);
    if (unitCost === null) throw new BadRequestException(`La oportunidad no tiene valoración en esa fecha o antes (inicia el ${series[0]?.date ?? 'sin datos'})`);
    const units = round(input.amount / unitCost, 6);

    const position = await this.prisma.$transaction(async (tx) => {
      const created = await tx.investment.create({
        data: { code: await this.prisma.nextCode('INV', tx), userId: client.id, opportunityId: opportunity.id, amount: input.amount, units, unitCost, investedAt: parseDay(day) },
      });
      await this.audit.log({ actor, action: 'INVESTMENT_CREATED', entity: 'Investment', entityId: created.id, metadata: { code: created.code, clientId: client.id, opportunityId: opportunity.id, amount: input.amount, unitCost } }, tx);
      return created;
    });
    await this.notifications.notify(client.id, {
      type: 'OPPORTUNITY',
      title: `Inversión registrada: ${position.code}`,
      body: `${opportunity.title}: ${input.amount} USD a ${unitCost} por unidad (${units} unidades).`,
      link: '/dashboard/inversiones',
    });
    return position;
  }

  async redeemPosition(actor: AuthUser, id: string, redeemDate?: string) {
    const position = await this.prisma.investment.findUnique({ where: { id }, include: { opportunity: { select: { title: true } } } });
    if (!position) throw new NotFoundException('Inversión no encontrada');
    if (position.status !== InvestmentStatus.ACTIVE) throw new ConflictException('Esta inversión ya fue rescatada');
    const day = assertValidDay(redeemDate ?? today(), 'La fecha de rescate');
    if (day < dayKey(position.investedAt)) throw new BadRequestException('La fecha de rescate no puede ser anterior a la inversión');
    const series = (await this.seriesFor([position.opportunityId])).get(position.opportunityId) ?? [];
    const unitValue = valueAt(series, day) ?? Number(position.unitCost);
    const redeemedValue = round(Number(position.units) * unitValue);

    const updated = await this.prisma.investment.update({ where: { id }, data: { status: InvestmentStatus.REDEEMED, redeemedAt: parseDay(day), redeemedValue } });
    await this.audit.log({ actor, action: 'INVESTMENT_REDEEMED', entity: 'Investment', entityId: id, metadata: { code: position.code, redeemedValue, unitValue } });
    await this.notifications.notify(position.userId, {
      type: 'OPPORTUNITY',
      title: `Inversión rescatada: ${position.code}`,
      body: `${position.opportunity.title}: valor de rescate ${redeemedValue} USD (${daysBetween(dayKey(position.investedAt), day)} días de tenencia).`,
      link: '/dashboard/inversiones',
    });
    return updated;
  }

  async listPositions(filter: { status?: InvestmentStatus; opportunityId?: string; userId?: string } = {}) {
    const rows = await this.prisma.investment.findMany({
      where: { ...(filter.status ? { status: filter.status } : {}), ...(filter.opportunityId ? { opportunityId: filter.opportunityId } : {}), ...(filter.userId ? { userId: filter.userId } : {}) },
      include: { opportunity: { select: { id: true, title: true, risk: true, status: true } }, user: { select: { id: true, fullName: true, email: true } } },
      orderBy: [{ investedAt: 'desc' }, { createdAt: 'desc' }],
    });
    const built = await this.buildPositions(rows);
    return built.map(({ row, input, metrics }) => ({
      id: row.id,
      code: row.code,
      user: (row as typeof row & { user: { id: string; fullName: string; email: string } }).user,
      opportunity: row.opportunity,
      amount: input.amount,
      units: input.units,
      unitCost: input.unitCost,
      investedAt: input.investedAt,
      status: row.status,
      redeemedAt: input.redeemedAt,
      redeemedValue: input.redeemedValue,
      ...metrics,
    }));
  }

  /** Cifras globales para el panel: activos bajo gestión (valor actual de posiciones abiertas) e inversionistas. */
  async summary() {
    const rows = await this.prisma.investment.findMany({ where: { status: InvestmentStatus.ACTIVE }, include: { opportunity: { select: { id: true, title: true, risk: true, status: true } } } });
    const built = await this.buildPositions(rows);
    const invested = built.reduce((s, b) => s + b.input.amount, 0);
    const value = built.reduce((s, b) => s + b.metrics.currentValue, 0);
    return {
      aum: round(value),
      invested: round(invested),
      pnl: round(value - invested),
      returnPct: invested > 0 ? round(((value - invested) / invested) * 100) : 0,
      investors: new Set(rows.map((r) => r.userId)).size,
      activePositions: rows.length,
    };
  }

  private async announce(opportunityId: string, title: string) {
    const clients = await this.prisma.user.findMany({ where: { role: Role.CLIENT, status: UserStatus.ACTIVE }, select: { id: true } });
    await this.notifications.notifyMany(clients.map((c) => c.id), {
      type: 'OPPORTUNITY',
      title: 'Nueva oportunidad de capital',
      body: title,
      link: `/dashboard/capital?oportunidad=${opportunityId}`,
    });
  }
}
