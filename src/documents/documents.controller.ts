import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { DocumentCategory, DocumentStatus, Role } from '@prisma/client';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { CurrentUser, Roles } from '../common/decorators';
import { PageQuery, pageArgs, paged } from '../common/pagination';
import { AuthUser } from '../common/types';
import { DocumentsService, MAX_UPLOAD_BYTES } from './documents.service';

class UploadDto {
  @IsEnum(DocumentCategory) category: DocumentCategory;
  @IsOptional() @IsString() disbursementId?: string;
  @IsOptional() @IsString() caseId?: string;
}

class ListQuery {
  @IsOptional() @IsEnum(DocumentCategory) category?: DocumentCategory;
}

class StaffListQuery extends PageQuery {
  @IsOptional() @IsEnum(DocumentStatus) status?: DocumentStatus;
  @IsOptional() @IsEnum(DocumentCategory) category?: DocumentCategory;
  @IsOptional() @IsString() ownerId?: string;
  @IsOptional() @IsString() search?: string;
}

class RejectDto {
  @IsString() @MaxLength(500) reason: string;
}

@Controller('documents')
export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Post()
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } }))
  upload(@CurrentUser() user: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: UploadDto) {
    return this.documents.upload(user, file, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: ListQuery) {
    return this.documents.listOwn(user.id, q.category);
  }

  @Get(':id/download')
  download(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.documents.download(user, id);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.documents.remove(user, id);
  }
}

@Controller('admin/documents')
@Roles(Role.SUPERADMIN, Role.LAWYER)
export class AdminDocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  @Get()
  async list(@Query() q: StaffListQuery) {
    const { page, pageSize, skip, take } = pageArgs(q);
    const { items, total } = await this.documents.listForStaff(q, skip, take);
    return paged(items, total, page, pageSize);
  }

  @Post(':id/validate') @HttpCode(200)
  validate(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.documents.review(actor, id, 'VALIDATED');
  }

  @Post(':id/reject') @HttpCode(200)
  reject(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: RejectDto) {
    return this.documents.review(actor, id, 'REJECTED', dto.reason);
  }
}
