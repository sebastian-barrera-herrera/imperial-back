import { Module } from '@nestjs/common';
import { AdminDocumentsController, DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';

@Module({ controllers: [DocumentsController, AdminDocumentsController], providers: [DocumentsService], exports: [DocumentsService] })
export class DocumentsModule {}
