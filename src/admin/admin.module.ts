import { Module } from '@nestjs/common';
import { InvestmentsModule } from '../investments/investments.module';
import { StatsController } from './stats.controller';

@Module({ imports: [InvestmentsModule], controllers: [StatsController] })
export class AdminModule {}
