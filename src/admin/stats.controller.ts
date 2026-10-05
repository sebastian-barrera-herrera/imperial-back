import { Controller, Get } from '@nestjs/common';
import { DisbursementStatus, DocumentStatus, InterestStatus, Role } from '@prisma/client';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/types';
import { InvestmentsService } from '../investments/investments.service';
import { PrismaService } from '../prisma/prisma.service';

const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;

@Controller('admin/stats')
@Roles(Role.SUPERADMIN, Role.LAWYER)
export class StatsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly investments: InvestmentsService,
  ) {}

  @Get()
  async stats(@CurrentUser() actor: AuthUser) {
    const isSuper = actor.role === Role.SUPERADMIN;
    const caseScope = isSuper ? {} : { lawyerId: actor.id };
    const now = new Date();
    const since = new Date(now.getFullYear(), now.getMonth() - 5, 1);

    const [clients, pendingDocuments, pendingDisbursements, activeCases, disbursed, pipeline, byStatus, byStage, recent, pendingInterests, recentActivity, investmentSummary] = await Promise.all([
      this.prisma.user.count({ where: { role: Role.CLIENT, status: 'ACTIVE' } }),
      this.prisma.document.count({ where: { status: DocumentStatus.PENDING } }),
      this.prisma.disbursementRequest.count({ where: { status: DisbursementStatus.PENDING } }),
      this.prisma.case.count({ where: { ...caseScope, status: { not: 'CLOSED' } } }),
      this.prisma.disbursementRequest.aggregate({ _sum: { amount: true }, where: { status: DisbursementStatus.DISBURSED } }),
      this.prisma.disbursementRequest.aggregate({ _sum: { amount: true }, where: { status: { in: ['PENDING', 'APPROVED', 'IN_PROCESS'] } } }),
      this.prisma.disbursementRequest.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.case.groupBy({ by: ['stage'], where: caseScope, _count: { _all: true } }),
      this.prisma.disbursementRequest.findMany({ where: { createdAt: { gte: since } }, select: { createdAt: true, amount: true, status: true } }),
      isSuper ? this.prisma.opportunityInterest.count({ where: { status: InterestStatus.PENDING } }) : Promise.resolve(null),
      isSuper ? this.prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 8 }) : Promise.resolve(null),
      isSuper ? this.investments.summary() : Promise.resolve(null),
    ]);

    const months = Array.from({ length: 6 }, (_, i) => monthKey(new Date(now.getFullYear(), now.getMonth() - 5 + i, 1)));
    const monthly = months.map((month) => ({ month, requested: 0, requestedAmount: 0, disbursedAmount: 0 }));
    for (const r of recent) {
      const bucket = monthly.find((m) => m.month === monthKey(r.createdAt));
      if (!bucket) continue;
      bucket.requested += 1;
      bucket.requestedAmount += Number(r.amount);
      if (r.status === 'DISBURSED') bucket.disbursedAmount += Number(r.amount);
    }

    return {
      clients,
      pendingDocuments,
      pendingDisbursements,
      activeCases,
      pendingInterests,
      totalDisbursed: disbursed._sum.amount?.toString() ?? '0',
      pipelineAmount: pipeline._sum.amount?.toString() ?? '0',
      disbursementsByStatus: byStatus.map((s) => ({ status: s.status, count: s._count._all })),
      casesByStage: byStage.map((s) => ({ stage: s.stage, count: s._count._all })),
      monthly,
      recentActivity,
      investments: investmentSummary,
    };
  }
}
