import { Global, Module } from '@nestjs/common';
import { AdminNotificationsController, NotificationsController } from './notifications.controller';
import { NotificationsHub } from './notifications.hub';
import { NotificationsService } from './notifications.service';

@Global()
@Module({
  controllers: [NotificationsController, AdminNotificationsController],
  providers: [NotificationsHub, NotificationsService],
  exports: [NotificationsService, NotificationsHub],
})
export class NotificationsModule {}
