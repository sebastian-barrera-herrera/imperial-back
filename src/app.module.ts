import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
import { AdminModule } from './admin/admin.module';
import { AuditModule } from './audit/audit.module';
import { AuthModule } from './auth/auth.module';
import { CasesModule } from './cases/cases.module';
import { CommonModule } from './common/common.module';
import { JwtAuthGuard, RolesGuard } from './common/guards';
import { requestContextMiddleware } from './common/request-context';
import { validateEnv } from './config/env';
import { DisbursementsModule } from './disbursements/disbursements.module';
import { DocumentsModule } from './documents/documents.module';
import { HealthController } from './health.controller';
import { InvestmentsModule } from './investments/investments.module';
import { NotificationsModule } from './notifications/notifications.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProfileModule } from './profile/profile.module';
import { ReportsModule } from './reports/reports.module';
import { StorageModule } from './storage/storage.module';
import { UsersModule } from './users/users.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    ThrottlerModule.forRoot({
      throttlers: [{ limit: 300, ttl: 60_000 }],
      // En los tests e2e se desactiva para poder repetir logins sin bloqueos.
      skipIf: () => process.env.NODE_ENV === 'test',
    }),
    PrismaModule,
    CommonModule,
    StorageModule,
    AuditModule,
    AuthModule,
    NotificationsModule,
    ProfileModule,
    UsersModule,
    DocumentsModule,
    DisbursementsModule,
    CasesModule,
    InvestmentsModule,
    ReportsModule,
    AdminModule,
  ],
  controllers: [HealthController],
  providers: [
    // Orden importa: throttling -> autenticación -> autorización por rol.
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply(requestContextMiddleware).forRoutes('*path');
  }
}
