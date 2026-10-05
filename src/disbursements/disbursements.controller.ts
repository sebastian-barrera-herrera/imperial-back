import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { DisbursementStatus, Role } from '@prisma/client';
import { ArrayMaxSize, IsArray, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';
import { CurrentUser, Public, Roles } from '../common/decorators';
import { toCsvFile } from '../common/csv';
import { PageQuery, pageArgs, paged } from '../common/pagination';
import { AuthUser } from '../common/types';
import { DisbursementsService, STATUS_LABELS } from './disbursements.service';

class CreateDisbursementDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(999_999_999_999)
  amount: number;

  @IsString() @MinLength(3) @MaxLength(200)
  concept: string;

  @IsOptional() @IsString() caseId?: string;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  documentIds?: string[];
}

class AttachDto {
  @IsArray() @ArrayMaxSize(20) @IsString({ each: true })
  documentIds: string[];
}

class OwnListQuery {
  @IsOptional() @IsEnum(DisbursementStatus) status?: DisbursementStatus;
}

class StaffListQuery extends PageQuery {
  @IsOptional() @IsEnum(DisbursementStatus) status?: DisbursementStatus;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() clientId?: string;
}

class StatusDto {
  @IsEnum(DisbursementStatus) status: DisbursementStatus;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
}

@Controller('disbursements')
export class DisbursementsController {
  constructor(private readonly service: DisbursementsService) {}

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateDisbursementDto) {
    return this.service.create(user, dto);
  }

  @Get()
  list(@CurrentUser() user: AuthUser, @Query() q: OwnListQuery) {
    return this.service.listOwn(user.id, q.status);
  }

  /** Historial de transacciones descargable. */
  @Get('export.csv')
  async export(@CurrentUser() user: AuthUser) {
    const rows = await this.service.listOwn(user.id);
    return toCsvFile(
      'mis-solicitudes-de-desembolso.csv',
      ['Código', 'Fecha', 'Concepto', 'Monto', 'Moneda', 'Estado', 'Caso', 'Desembolsada el'],
      rows.map((r) => [r.code, r.createdAt, r.concept, r.amount.toString(), r.currency, STATUS_LABELS[r.status], r.case?.number ?? '', r.disbursedAt ?? '']),
    );
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.detail(user.id, id);
  }

  /** Documento de aprobación en PDF (con logo, marca de agua y código de verificación). */
  @Get(':id/approval-pdf')
  approvalPdf(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.approvalPdf(user, id);
  }

  @Post(':id/cancel') @HttpCode(200)
  cancel(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.service.cancel(user, id);
  }

  @Post(':id/documents') @HttpCode(200)
  attach(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: AttachDto) {
    return this.service.attachDocuments(user, id, dto.documentIds);
  }
}

@Controller('admin/disbursements')
@Roles(Role.SUPERADMIN, Role.LAWYER)
export class AdminDisbursementsController {
  constructor(private readonly service: DisbursementsService) {}

  @Get()
  async list(@Query() q: StaffListQuery) {
    const { page, pageSize, skip, take } = pageArgs(q);
    const { items, total } = await this.service.listForStaff(q, skip, take);
    return paged(items, total, page, pageSize);
  }

  @Get(':id')
  detail(@Param('id') id: string) {
    return this.service.detail(null, id);
  }

  @Get(':id/approval-pdf')
  approvalPdf(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.service.approvalPdf(actor, id);
  }

  @Patch(':id/status')
  async setStatus(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: StatusDto) {
    await this.service.transition(actor, id, dto.status, dto.note);
    return this.service.detail(null, id);
  }
}

class VerifyQuery {
  @IsString() @MaxLength(40) ref: string;
  @IsString() @MaxLength(40) code: string;
}

/** Verificación pública de un documento de aprobación (la usa la página /verificar y el QR del PDF). */
@Controller('public/verify')
@Public()
export class VerifyController {
  constructor(private readonly service: DisbursementsService) {}

  @Get()
  verify(@Query() q: VerifyQuery) {
    return this.service.verifyApproval(q.ref, q.code);
  }
}
