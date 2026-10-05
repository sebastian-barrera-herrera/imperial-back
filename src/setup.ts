import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

/** Configuración compartida entre el arranque real y los tests e2e. */
export function configureApp(app: INestApplication) {
  const config = app.get(ConfigService);
  const express = app as NestExpressApplication;
  // Detrás de Next/nginx la IP real llega en X-Forwarded-For (para rate limit y auditoría).
  express.set('trust proxy', 1);
  app.setGlobalPrefix('api');
  app.use(helmet());
  app.use(cookieParser());
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  app.enableCors({ origin: config.get<string>('CORS_ORIGIN')?.split(','), credentials: true });
}
