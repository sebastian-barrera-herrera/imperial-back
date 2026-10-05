import { CanActivate, ExecutionContext, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { Role, UserStatus } from '@prisma/client';
import { Request } from 'express';
import { PrismaService } from '../prisma/prisma.service';
import { IS_PUBLIC_KEY, ROLES_KEY } from './decorators';

export const ACCESS_COOKIE = 'ilg_at';
export const REFRESH_COOKIE = 'ilg_rt';

function extractToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice(7);
  return req.cookies?.[ACCESS_COOKIE];
}

@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const token = extractToken(req);
    if (!token) throw new UnauthorizedException('Sesión requerida');

    let sub: string;
    try {
      ({ sub } = await this.jwt.verifyAsync<{ sub: string }>(token));
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    // Se consulta el usuario en cada petición para que suspensiones y cambios de rol apliquen al instante.
    const user = await this.prisma.user.findUnique({
      where: { id: sub },
      select: { id: true, email: true, fullName: true, role: true, status: true },
    });
    if (!user || user.status !== UserStatus.ACTIVE) throw new UnauthorizedException('Cuenta no disponible');

    req.user = { id: user.id, email: user.email, fullName: user.fullName, role: user.role };
    return true;
  }
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [context.getHandler(), context.getClass()]);
    if (!roles?.length) return true;
    const user = context.switchToHttp().getRequest<Request>().user;
    if (!user || !roles.includes(user.role)) throw new ForbiddenException('No tienes permisos para esta acción');
    return true;
  }
}
