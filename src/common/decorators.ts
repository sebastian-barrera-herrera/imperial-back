import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Request } from 'express';
import { AuthUser } from './types';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

/** Ruta accesible sin sesión. */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
/** Restringe la ruta a los roles indicados (por defecto basta con estar autenticado). */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  const req = ctx.switchToHttp().getRequest<Request>();
  return req.user as AuthUser;
});
