import { BadRequestException, ConflictException, ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Role, User, UserStatus } from '@prisma/client';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'crypto';
import { CookieOptions, Response } from 'express';
import { AuditService } from '../audit/audit.service';
import { ACCESS_COOKIE, REFRESH_COOKIE } from '../common/guards';
import { PRIVACY_VERSION } from '../common/legal';
import { getRequestContext } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { ChangePasswordDto, LoginDto, RegisterDto } from './dto';

export const REFRESH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;
// Hash de relleno para igualar tiempos de respuesta cuando el correo no existe.
const DUMMY_HASH = bcrypt.hashSync('imperial-dummy-password', BCRYPT_COST);

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export const publicUser = (user: Pick<User, 'id' | 'email' | 'fullName' | 'role' | 'status'>) => ({
  id: user.id,
  email: user.email,
  fullName: user.fullName,
  role: user.role,
  status: user.status,
});

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
  ) {}

  hashPassword(password: string) {
    return bcrypt.hash(password, BCRYPT_COST);
  }

  async register(dto: RegisterDto, res: Response) {
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email }, select: { id: true } });
    if (exists) throw new ConflictException('Ya existe una cuenta con ese correo');

    const user = await this.prisma.user.create({
      data: {
        email: dto.email,
        fullName: dto.fullName,
        passwordHash: await this.hashPassword(dto.password),
        role: Role.CLIENT,
        privacyAcceptedAt: new Date(),
        privacyVersion: PRIVACY_VERSION,
        profile: { create: {} },
        preference: { create: {} },
      },
    });
    await this.audit.log({ actor: user, action: 'USER_REGISTERED', entity: 'User', entityId: user.id, metadata: { privacyVersion: PRIVACY_VERSION } });
    await this.issueSession(user, res);
    return publicUser(user);
  }

  async login(dto: LoginDto, res: Response) {
    const user = await this.prisma.user.findUnique({ where: { email: dto.email } });
    const valid = await bcrypt.compare(dto.password, user?.passwordHash ?? DUMMY_HASH);
    if (user && valid && user.status !== UserStatus.ACTIVE) {
      // Solo quien acierta la contraseña llega aquí, así que no se revela qué correos existen.
      await this.audit.log({ actor: user, action: 'LOGIN_BLOCKED', entity: 'User', entityId: user.id, metadata: { status: user.status } });
      throw new ForbiddenException('Tu acceso a la plataforma fue desactivado. Comunícate con el despacho.');
    }
    if (!user || !valid) {
      await this.audit.log({ actor: null, action: 'LOGIN_FAILED', entity: 'User', metadata: { email: dto.email } });
      throw new UnauthorizedException('Correo o contraseña incorrectos');
    }
    await this.prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
    await this.audit.log({ actor: user, action: 'LOGIN', entity: 'User', entityId: user.id });
    await this.issueSession(user, res);
    return publicUser(user);
  }

  /** Rota el refresh token; si se reutiliza uno ya revocado se invalidan todas las sesiones del usuario. */
  async refresh(token: string | undefined, res: Response) {
    if (!token) throw new UnauthorizedException('Sesión requerida');
    const stored = await this.prisma.refreshToken.findUnique({ where: { tokenHash: sha256(token) }, include: { user: true } });
    if (!stored) throw new UnauthorizedException('Sesión inválida');
    if (stored.revokedAt) {
      await this.prisma.refreshToken.updateMany({ where: { userId: stored.userId, revokedAt: null }, data: { revokedAt: new Date() } });
      await this.audit.log({ actor: stored.user, action: 'REFRESH_TOKEN_REUSE', entity: 'User', entityId: stored.userId });
      this.clearCookies(res);
      throw new UnauthorizedException('Sesión inválida');
    }
    if (stored.expiresAt < new Date() || stored.user.status !== UserStatus.ACTIVE) {
      this.clearCookies(res);
      throw new UnauthorizedException('Sesión expirada');
    }
    await this.prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
    await this.issueSession(stored.user, res);
    return publicUser(stored.user);
  }

  async logout(token: string | undefined, res: Response) {
    if (token) await this.prisma.refreshToken.updateMany({ where: { tokenHash: sha256(token), revokedAt: null }, data: { revokedAt: new Date() } });
    this.clearCookies(res);
    return { ok: true };
  }

  async changePassword(userId: string, dto: ChangePasswordDto, res: Response) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    if (!(await bcrypt.compare(dto.currentPassword, user.passwordHash))) {
      // 400 y no 401: el usuario sí está autenticado; un 401 haría que el cliente cierre la sesión.
      throw new BadRequestException('La contraseña actual no es correcta');
    }
    await this.prisma.user.update({ where: { id: userId }, data: { passwordHash: await this.hashPassword(dto.newPassword) } });
    // Cierra el resto de sesiones y abre una nueva para este dispositivo.
    await this.prisma.refreshToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: new Date() } });
    await this.audit.log({ actor: user, action: 'PASSWORD_CHANGED', entity: 'User', entityId: userId });
    await this.issueSession(user, res);
    return { ok: true };
  }

  async issueSession(user: Pick<User, 'id' | 'role'>, res: Response) {
    const access = await this.jwt.signAsync({ sub: user.id, role: user.role });
    const refresh = randomBytes(48).toString('base64url');
    const ctx = getRequestContext();
    await this.prisma.refreshToken.create({
      data: {
        userId: user.id,
        tokenHash: sha256(refresh),
        expiresAt: new Date(Date.now() + REFRESH_TTL_MS),
        userAgent: ctx.userAgent?.slice(0, 255),
        ip: ctx.ip,
      },
    });
    res.cookie(ACCESS_COOKIE, access, this.cookieOptions('/'));
    res.cookie(REFRESH_COOKIE, refresh, this.cookieOptions('/api/auth'));
  }

  private cookieOptions(path: string): CookieOptions {
    return {
      httpOnly: true,
      secure: this.config.get<boolean>('COOKIE_SECURE'),
      sameSite: 'lax',
      path,
      // La cookie de acceso vive lo mismo que la sesión; el JWT que contiene expira a los 15 min y se renueva con /auth/refresh.
      maxAge: REFRESH_TTL_MS,
    };
  }

  private clearCookies(res: Response) {
    res.clearCookie(ACCESS_COOKIE, { path: '/' });
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  }
}
