import { Body, Controller, Delete, Get, Param, Post, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { IssuedDocumentCategory, Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsEnum, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/types';
import { MAX_UPLOAD_BYTES } from '../documents/documents.service';
import { IssuedDocumentsService } from './issued-documents.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class IssueDto {
  @Transform(trim) @IsString() @Length(3, 160) title: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(500) description?: string;
  @IsEnum(IssuedDocumentCategory) category: IssuedDocumentCategory;
  @IsOptional() @IsString() caseId?: string;
}

/** Lo que ve el cliente: los documentos que el despacho le entregó. */
@Controller('issued-documents')
@Roles(Role.CLIENT)
export class IssuedDocumentsController {
  constructor(private readonly docs: IssuedDocumentsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.docs.listOwn(user);
  }

  @Get(':id/download')
  download(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.docs.download(user, id);
  }
}

/** El superadmin entrega documentos a un cliente, los consulta y los retira. */
@Controller('admin')
@Roles(Role.SUPERADMIN)
export class AdminIssuedDocumentsController {
  constructor(private readonly docs: IssuedDocumentsService) {}

  @Get('clients/:clientId/issued-documents')
  list(@Param('clientId') clientId: string) {
    return this.docs.listForClient(clientId);
  }

  @Post('clients/:clientId/issued-documents')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@CurrentUser() actor: AuthUser, @Param('clientId') clientId: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: IssueDto) {
    return this.docs.upload(actor, clientId, file, dto);
  }

  @Get('issued-documents/:id/download')
  download(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.docs.download(actor, id);
  }

  @Delete('issued-documents/:id')
  remove(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.docs.remove(actor, id);
  }
}
