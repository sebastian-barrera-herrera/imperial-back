import { Body, Controller, Delete, Get, Param, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { memoryStorage } from 'multer';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/types';
import { MAX_ORIGINAL_BYTES, MAX_VERSION_BYTES, StudioService } from './studio.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class UploadDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(160) title?: string;
}

class VersionDto {
  @IsOptional() @Transform(trim) @IsString() @MaxLength(120) label?: string;
  /** JSON con la lista de ediciones de texto aplicadas. */
  @IsOptional() @IsString() @MaxLength(100_000) edits?: string;
}

class VersionQuery {
  @IsOptional() @IsString() download?: string;
}

@Controller('admin/studio')
@Roles(Role.SUPERADMIN)
export class StudioController {
  constructor(private readonly studio: StudioService) {}

  @Get('images')
  list() {
    return this.studio.list();
  }

  @Post('images')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_ORIGINAL_BYTES, files: 1 } }))
  upload(@CurrentUser() actor: AuthUser, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: UploadDto) {
    return this.studio.upload(actor, file, dto.title);
  }

  @Get('images/:id')
  detail(@Param('id') id: string) {
    return this.studio.detail(id);
  }

  @Get('images/:id/original')
  original(@Param('id') id: string) {
    return this.studio.original(id);
  }

  @Post('images/:id/versions')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_VERSION_BYTES, files: 1 } }))
  saveVersion(@CurrentUser() actor: AuthUser, @Param('id') id: string, @UploadedFile() file: Express.Multer.File | undefined, @Body() dto: VersionDto) {
    return this.studio.saveVersion(actor, id, file, dto.label, dto.edits);
  }

  @Get('versions/:id')
  version(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Query() q: VersionQuery) {
    return this.studio.version(actor, id, q.download === '1');
  }

  @Delete('images/:id')
  remove(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.studio.remove(actor, id);
  }
}
