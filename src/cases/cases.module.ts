import { Module } from '@nestjs/common';
import { AdminCasesController, CasesController } from './cases.controller';
import { CasesService } from './cases.service';

@Module({ controllers: [CasesController, AdminCasesController], providers: [CasesService] })
export class CasesModule {}
