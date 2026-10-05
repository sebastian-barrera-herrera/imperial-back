import { Module } from '@nestjs/common';
import { AdminInvestmentsController, InvestmentsController } from './investments.controller';
import { InvestmentsService } from './investments.service';

@Module({ controllers: [InvestmentsController, AdminInvestmentsController], providers: [InvestmentsService], exports: [InvestmentsService] })
export class InvestmentsModule {}
