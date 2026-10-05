import { Module } from '@nestjs/common';
import { AdminClientsController, AdminDepositsController, ClientSelfController } from './clients-admin.controller';
import { ClientsAdminService } from './clients-admin.service';

@Module({ controllers: [AdminClientsController, AdminDepositsController, ClientSelfController], providers: [ClientsAdminService] })
export class ClientsAdminModule {}
