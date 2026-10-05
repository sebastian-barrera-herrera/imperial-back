import { Module } from '@nestjs/common';
import { AdminIssuedDocumentsController, IssuedDocumentsController } from './issued-documents.controller';
import { IssuedDocumentsService } from './issued-documents.service';

@Module({ controllers: [IssuedDocumentsController, AdminIssuedDocumentsController], providers: [IssuedDocumentsService] })
export class IssuedDocumentsModule {}
