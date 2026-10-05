import { Module } from '@nestjs/common';
import { AdminContentController, PublicContentController } from './content.controller';
import { ContentService } from './content.service';

@Module({ controllers: [PublicContentController, AdminContentController], providers: [ContentService] })
export class ContentModule {}
