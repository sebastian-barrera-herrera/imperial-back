import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Put, Query, Sse } from '@nestjs/common';
import { NotificationType, Role } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { Observable, map } from 'rxjs';
import { AuditService } from '../audit/audit.service';
import { CurrentUser, Roles } from '../common/decorators';
import { PageQuery, pageArgs, paged } from '../common/pagination';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsHub } from './notifications.hub';
import { NotificationsService } from './notifications.service';

class ListQuery extends PageQuery {
  @IsOptional() @Transform(({ value }) => value === 'true' || value === true) @IsBoolean()
  unread?: boolean;

  @IsOptional() @IsEnum(NotificationType)
  type?: NotificationType;
}

class PreferencesDto {
  @IsOptional() @IsBoolean() documents?: boolean;
  @IsOptional() @IsBoolean() disbursements?: boolean;
  @IsOptional() @IsBoolean() cases?: boolean;
  @IsOptional() @IsBoolean() opportunities?: boolean;
  @IsOptional() @IsBoolean() email?: boolean;
}

class BroadcastDto {
  @IsIn(['USER', 'ALL_CLIENTS']) audience: 'USER' | 'ALL_CLIENTS';
  @IsOptional() @IsString() userId?: string;
  @IsEnum(NotificationType) type: NotificationType;
  @IsString() @MaxLength(120) title: string;
  @IsOptional() @IsString() @MaxLength(1000) body?: string;
  // Solo rutas internas de la aplicación (evita enlaces externos / phishing).
  @IsOptional() @IsString() @MaxLength(200) @Matches(/^\/(?!\/)[^\s]*$/, { message: 'El enlace debe ser una ruta interna que empiece por /' })
  link?: string;
}

@Controller('notifications')
export class NotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hub: NotificationsHub,
  ) {}

  @Get()
  async list(@CurrentUser() user: AuthUser, @Query() q: ListQuery) {
    const { page, pageSize, skip, take } = pageArgs(q);
    const where = {
      userId: user.id,
      ...(q.unread ? { readAt: null } : {}),
      ...(q.type ? { type: q.type } : {}),
    };
    const [items, total, unread] = await Promise.all([
      this.prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    ]);
    return { ...paged(items, total, page, pageSize), unread };
  }

  @Get('unread-count')
  async unreadCount(@CurrentUser() user: AuthUser) {
    return { unread: await this.prisma.notification.count({ where: { userId: user.id, readAt: null } }) };
  }

  /** Canal de eventos en tiempo real (Server-Sent Events). */
  @Sse('stream')
  stream(@CurrentUser() user: AuthUser): Observable<{ type: string; data: unknown }> {
    return this.hub.stream(user.id).pipe(map((m) => m));
  }

  @Get('preferences')
  async preferences(@CurrentUser() user: AuthUser) {
    return this.prisma.notificationPreference.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  }

  @Put('preferences')
  async updatePreferences(@CurrentUser() user: AuthUser, @Body() dto: PreferencesDto) {
    return this.prisma.notificationPreference.upsert({ where: { userId: user.id }, create: { userId: user.id, ...dto }, update: dto });
  }

  @Post('read-all')
  @HttpCode(200)
  async readAll(@CurrentUser() user: AuthUser) {
    const { count } = await this.prisma.notification.updateMany({ where: { userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return { updated: count };
  }

  @Post(':id/read')
  @HttpCode(200)
  async read(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.notification.updateMany({ where: { id, userId: user.id, readAt: null }, data: { readAt: new Date() } });
    return { ok: true };
  }

  @Delete(':id')
  async remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    await this.prisma.notification.deleteMany({ where: { id, userId: user.id } });
    return { ok: true };
  }
}

@Controller('admin/notifications')
@Roles(Role.SUPERADMIN, Role.LAWYER)
export class AdminNotificationsController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly audit: AuditService,
  ) {}

  /** Envía una alerta manual a un cliente o a todos los clientes activos. */
  @Post()
  @HttpCode(201)
  async send(@CurrentUser() actor: AuthUser, @Body() dto: BroadcastDto) {
    const { audience, userId, ...content } = dto;
    let sent = 0;
    if (audience === 'USER') {
      if (!userId) throw new BadRequestException('userId es obligatorio para enviar a un usuario');
      const target = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
      if (!target) throw new NotFoundException('Usuario no encontrado');
      sent = (await this.notifications.notify(target.id, content)) ? 1 : 0;
    } else {
      if (actor.role !== Role.SUPERADMIN) throw new ForbiddenException('Solo el superadmin puede enviar alertas masivas');
      const clients = await this.prisma.user.findMany({ where: { role: Role.CLIENT, status: 'ACTIVE' }, select: { id: true } });
      sent = await this.notifications.notifyMany(clients.map((c) => c.id), content);
    }
    await this.audit.log({ actor, action: 'NOTIFICATION_SENT', entity: 'Notification', metadata: { audience, userId: userId ?? null, title: content.title, sent } });
    return { sent };
  }
}
