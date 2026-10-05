import { Module } from '@nestjs/common';
import { AdminDisbursementsController, DisbursementsController, VerifyController } from './disbursements.controller';
import { DisbursementsService } from './disbursements.service';

@Module({ controllers: [DisbursementsController, AdminDisbursementsController, VerifyController], providers: [DisbursementsService] })
export class DisbursementsModule {}
