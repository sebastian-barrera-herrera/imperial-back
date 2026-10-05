import { Body, Controller, Get, HttpCode, Post, Req, Res } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { Request, Response } from 'express';
import { CurrentUser, Public } from '../common/decorators';
import { REFRESH_COOKIE } from '../common/guards';
import { AuthUser } from '../common/types';
import { PrismaService } from '../prisma/prisma.service';
import { AuthService, publicUser } from './auth.service';
import { ChangePasswordDto, LoginDto, RegisterDto } from './dto';

const STRICT = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public() @Throttle(STRICT) @Post('register')
  register(@Body() dto: RegisterDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.register(dto, res);
  }

  @Public() @Throttle(STRICT) @Post('login') @HttpCode(200)
  login(@Body() dto: LoginDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.login(dto, res);
  }

  @Public() @Throttle({ default: { limit: 60, ttl: 60_000 } }) @Post('refresh') @HttpCode(200)
  refresh(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.refresh(req.cookies?.[REFRESH_COOKIE], res);
  }

  @Public() @Post('logout') @HttpCode(200)
  logout(@Req() req: Request, @Res({ passthrough: true }) res: Response) {
    return this.auth.logout(req.cookies?.[REFRESH_COOKIE], res);
  }

  @Get('me')
  async me(@CurrentUser() user: AuthUser) {
    const full = await this.prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    return publicUser(full);
  }

  @Throttle(STRICT) @Post('change-password') @HttpCode(200)
  changePassword(@CurrentUser() user: AuthUser, @Body() dto: ChangePasswordDto, @Res({ passthrough: true }) res: Response) {
    return this.auth.changePassword(user.id, dto, res);
  }
}
