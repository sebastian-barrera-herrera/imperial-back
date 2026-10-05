import { BadRequestException, Body, Controller, ForbiddenException, Get, NotFoundException, Param, Patch, Post, Query } from '@nestjs/common';
import { DocumentStatus, Prisma, Role, UserStatus } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { randomInt } from 'crypto';
import { AuditService } from '../audit/audit.service';
import { AuthService, publicUser } from '../auth/auth.service';
import { CurrentUser, Roles } from '../common/decorators';
import { PageQuery, pageArgs, paged } from '../common/pagination';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { ProfileService } from '../profile/profile.service';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);

class UsersQuery extends PageQuery {
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
}

class CreateUserDto {
  @IsString() @MinLength(3) @MaxLength(120) fullName: string;
  @Transform(lower) @IsEmail() email: string;
  @IsEnum(Role) role: Role;
}

class UpdateUserDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(120) fullName?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
}

/** Contraseña temporal legible: 14 caracteres, siempre con letras y dígitos. */
function temporaryPassword(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const chars = Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]);
  return `${chars.join('')}${randomInt(2, 10)}${alphabet[randomInt(24)]}`;
}

@Controller('admin/users')
@Roles(Role.SUPERADMIN)
export class UsersController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  async list(@Query() q: UsersQuery) {
    const { page, pageSize, skip, take } = pageArgs(q);
    const where: Prisma.UserWhereInput = {
      ...(q.role ? { role: q.role } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? { OR: [{ email: { contains: q.search, mode: 'insensitive' } }, { fullName: { contains: q.search, mode: 'insensitive' } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.user.count({ where }),
    ]);
    return paged(rows.map((u) => ({ ...publicUser(u), lastLoginAt: u.lastLoginAt, createdAt: u.createdAt })), total, page, pageSize);
  }

  @Post()
  async create(@CurrentUser() actor: AuthUser, @Body() dto: CreateUserDto) {
    if (await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } })) {
      throw new BadRequestException('Ya existe una cuenta con ese correo');
    }
    const password = temporaryPassword();
    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        fullName: dto.fullName,
        role: dto.role,
        passwordHash: await this.auth.hashPassword(password),
        profile: { create: {} },
        preference: { create: {} },
      },
    });
    await this.audit.log({ actor, action: 'USER_CREATED', entity: 'User', entityId: user.id, metadata: { role: dto.role } });
    // La contraseña temporal se muestra una sola vez al superadmin; no se almacena en claro.
    return { user: publicUser(user), temporaryPassword: password };
  }

  @Patch(':id')
  async update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateUserDto) {
    const target = await this.prisma.user.findUnique({ where: { id } });
    if (!target) throw new NotFoundException('Usuario no encontrado');

    const losesAdmin =
      target.role === Role.SUPERADMIN &&
      ((dto.role && dto.role !== Role.SUPERADMIN) || dto.status === UserStatus.SUSPENDED);
    if (losesAdmin) {
      if (target.id === actor.id) throw new ForbiddenException('No puedes quitarte el rol ni suspender tu propia cuenta');
      const others = await this.prisma.user.count({ where: { role: Role.SUPERADMIN, status: UserStatus.ACTIVE, id: { not: id } } });
      if (others === 0) throw new ForbiddenException('Debe existir al menos un superadmin activo');
    }
    if (target.id === actor.id && dto.status === UserStatus.SUSPENDED) {
      throw new ForbiddenException('No puedes suspender tu propia cuenta');
    }

    const updated = await this.prisma.user.update({ where: { id }, data: dto });
    if (dto.status === UserStatus.SUSPENDED) {
      await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    }
    await this.audit.log({
      actor,
      action: 'USER_UPDATED',
      entity: 'User',
      entityId: id,
      metadata: { before: { role: target.role, status: target.status }, after: { role: updated.role, status: updated.status } },
    });
    return publicUser(updated);
  }

  @Post(':id/reset-password')
  async resetPassword(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!target) throw new NotFoundException('Usuario no encontrado');
    const password = temporaryPassword();
    await this.prisma.user.update({ where: { id }, data: { passwordHash: await this.auth.hashPassword(password) } });
    await this.prisma.refreshToken.updateMany({ where: { userId: id, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ actor, action: 'PASSWORD_RESET', entity: 'User', entityId: id });
    return { temporaryPassword: password };
  }
}

class ClientsQuery extends PageQuery {
  @IsOptional() @IsString() search?: string;
  /** ACTIVE = con acceso; SUSPENDED = dados de baja. */
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
}

/** Consulta de clientes para el personal (superadmin y abogados). */
@Controller('admin')
@Roles(Role.SUPERADMIN, Role.LAWYER)
export class StaffDirectoryController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: ProfileService,
    private readonly audit: AuditService,
  ) {}

  @Get('clients')
  async clients(@Query() q: ClientsQuery) {
    const { page, pageSize, skip, take } = pageArgs(q);
    const where: Prisma.UserWhereInput = {
      role: Role.CLIENT,
      ...(q.status ? { status: q.status } : {}),
      ...(q.search
        ? { OR: [{ email: { contains: q.search, mode: 'insensitive' } }, { fullName: { contains: q.search, mode: 'insensitive' } }] }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        select: {
          id: true, fullName: true, email: true, status: true, createdAt: true, deactivatedAt: true, deactivationReason: true,
          profile: { select: { country: true, phone: true } },
          advisor: { select: { id: true, fullName: true } },
          _count: { select: { clientCases: true, disbursements: true } },
          documents: { where: { status: DocumentStatus.PENDING }, select: { id: true } },
        },
      }),
      this.prisma.user.count({ where }),
    ]);
    const sums = await this.prisma.clientDeposit.groupBy({ by: ['clientId'], where: { clientId: { in: rows.map((r) => r.id) } }, _sum: { amount: true } });
    const deposited = new Map(sums.map((x) => [x.clientId, x._sum.amount?.toFixed(2) ?? '0.00']));
    const items = rows.map(({ documents, _count, profile, ...u }) => ({
      ...u, country: profile?.country ?? null, phone: profile?.phone ?? null,
      cases: _count.clientCases, disbursements: _count.disbursements, pendingDocuments: documents.length, depositTotal: deposited.get(u.id) ?? '0.00',
    }));
    return paged(items, total, page, pageSize);
  }

  @Get('clients/:id')
  async client(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    const user = await this.prisma.user.findFirst({ where: { id, role: Role.CLIENT }, include: { profile: true } });
    if (!user) throw new NotFoundException('Cliente no encontrado');
    // El acceso a datos sensibles (cédula, banco) queda auditado.
    await this.audit.log({ actor, action: 'CLIENT_PROFILE_VIEWED', entity: 'Profile', entityId: id });
    const advisor = user.advisorId ? await this.prisma.user.findUnique({ where: { id: user.advisorId }, select: { id: true, fullName: true } }) : null;
    return { ...this.profiles.present(user, user.profile), status: user.status, createdAt: user.createdAt, deactivatedAt: user.deactivatedAt, deactivationReason: user.deactivationReason, advisor };
  }

  @Get('lawyers')
  lawyers() {
    return this.prisma.user.findMany({
      where: { role: { in: [Role.LAWYER, Role.SUPERADMIN] }, status: UserStatus.ACTIVE },
      select: { id: true, fullName: true, email: true, role: true },
      orderBy: { fullName: 'asc' },
    });
  }
}
