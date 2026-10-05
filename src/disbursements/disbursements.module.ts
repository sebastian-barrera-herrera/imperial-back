import { Module } from '@nestjs/common';
import { AdminDisbursementsController, DisbursementsController } from './disbursements.controller';
import { DisbursementsService } from './disbursements.service';

@Module({ controllers: [DisbursementsController, AdminDisbursementsController], providers: [DisbursementsService] })
export class DisbursementsModule {}
