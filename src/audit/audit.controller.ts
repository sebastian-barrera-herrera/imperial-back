import { Controller, Get, Query } from '@nestjs/common';
import { Role } from '@prisma/client';
import { IsOptional, IsString } from 'class-validator';
import { Roles } from '../common/decorators';
import { PageQuery, pageArgs, paged } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';

class AuditQuery extends PageQuery {
  @IsOptional() @IsString() action?: string;
  @IsOptional() @IsString() entity?: string;
  @IsOptional() @IsString() search?: string;
}

@Controller('admin/audit')
@Roles(Role.SUPERADMIN)
export class AuditController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  async list(@Query() q: AuditQuery) {
    const { page, pageSize, skip, take } = pageArgs(q);
    const where = {
      ...(q.action ? { action: q.action } : {}),
      ...(q.entity ? { entity: q.entity } : {}),
      ...(q.search ? { actorEmail: { contains: q.search, mode: 'insensitive' as const } } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.auditLog.count({ where }),
    ]);
    return paged(items, total, page, pageSize);
  }
}
