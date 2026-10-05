import { Body, Controller, Delete, Get, Header, HttpCode, Param, Patch, Post, Put, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { Role } from '@prisma/client';
import { Response } from 'express';
import { memoryStorage } from 'multer';
import { CurrentUser, Public, Roles } from '../common/decorators';
import { AuthUser } from '../common/types';
import { ContentService, MAX_IMAGE_BYTES } from './content.service';
import { CreateTeamDto, CreateTestimonialDto, OrderDto, UpdateTeamDto, UpdateTestimonialDto } from './dto';

/** Lo que ve cualquier visitante de la web: solo elementos publicados. */
@Controller('public/content')
@Public()
export class PublicContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=15')
  list() {
    return this.content.publicContent();
  }

  @Get('images/:id')
  async image(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { stream, mime } = await this.content.publicImage(id);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return new StreamableFile(stream, { type: mime, disposition: 'inline' });
  }
}

@Controller('admin/content')
@Roles(Role.SUPERADMIN)
export class AdminContentController {
  constructor(private readonly content: ContentService) {}

  @Get()
  list() {
    return this.content.adminContent();
  }

  @Get('images/:id')
  async image(@Param('id') id: string, @Res({ passthrough: true }) res: Response) {
    const { stream, mime } = await this.content.adminImage(id);
    res.setHeader('Cache-Control', 'private, max-age=60');
    return new StreamableFile(stream, { type: mime, disposition: 'inline' });
  }

  @Post('images')
  @UseInterceptors(FileInterceptor('file', { storage: memoryStorage(), limits: { fileSize: MAX_IMAGE_BYTES, files: 1 } }))
  upload(@CurrentUser() actor: AuthUser, @UploadedFile() file: Express.Multer.File | undefined) {
    return this.content.uploadImage(actor, file);
  }

  @Post('samples') @HttpCode(200)
  samples(@CurrentUser() actor: AuthUser) {
    return this.content.importSamples(actor);
  }

  @Post('team')
  createTeam(@CurrentUser() actor: AuthUser, @Body() dto: CreateTeamDto) {
    return this.content.createTeam(actor, dto);
  }

  @Put('team/order')
  orderTeam(@CurrentUser() actor: AuthUser, @Body() dto: OrderDto) {
    return this.content.reorder(actor, 'team', dto.ids);
  }

  @Patch('team/:id')
  updateTeam(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateTeamDto) {
    return this.content.updateTeam(actor, id, dto);
  }

  @Delete('team/:id')
  removeTeam(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.content.removeTeam(actor, id);
  }

  @Post('testimonials')
  createTestimonial(@CurrentUser() actor: AuthUser, @Body() dto: CreateTestimonialDto) {
    return this.content.createTestimonial(actor, dto);
  }

  @Put('testimonials/order')
  orderTestimonials(@CurrentUser() actor: AuthUser, @Body() dto: OrderDto) {
    return this.content.reorder(actor, 'testimonials', dto.ids);
  }

  @Patch('testimonials/:id')
  updateTestimonial(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateTestimonialDto) {
    return this.content.updateTestimonial(actor, id, dto);
  }

  @Delete('testimonials/:id')
  removeTestimonial(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.content.removeTestimonial(actor, id);
  }
}
