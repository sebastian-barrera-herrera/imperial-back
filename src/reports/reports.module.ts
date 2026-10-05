import { Module } from '@nestjs/common';
import { InvestmentsModule } from '../investments/investments.module';
import { ReportsController } from './reports.controller';

@Module({ imports: [InvestmentsModule], controllers: [ReportsController] })
export class ReportsModule {}
