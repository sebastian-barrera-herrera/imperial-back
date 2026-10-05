import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { CaseStage, CaseStatus, DocumentCategory, Role } from '@prisma/client';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsEnum, IsNumber, IsOptional, IsString, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { CurrentUser, Roles } from '../common/decorators';
import { PageQuery, pageArgs, paged } from '../common/pagination';
import { AuthUser } from '../common/types';
import { CasesService } from './cases.service';

class RequirementDto {
  @IsString() @MinLength(2) @MaxLength(120) label: string;
  @IsEnum(DocumentCategory) category: DocumentCategory;
}

class CreateCaseDto {
  @IsString() clientId: string;
  @IsOptional() @IsString() lawyerId?: string;
  @IsString() @MinLength(3) @MaxLength(160) title: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999_999_999_999) amountClaimed?: number;
  @IsOptional() @IsString() @MaxLength(1000) nextSteps?: string;
  @IsOptional() @IsArray() @ArrayMaxSize(20) @ValidateNested({ each: true }) @Type(() => RequirementDto)
  requirements?: RequirementDto[];
}

class UpdateCaseDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
  @IsOptional() @IsString() lawyerId?: string;
  @IsOptional() @IsEnum(CaseStatus) status?: CaseStatus;
  @IsOptional() @IsEnum(CaseStage) stage?: CaseStage;
  @IsOptional() @IsString() @MaxLength(1000) nextSteps?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(999_999_999_999) amountClaimed?: number;
}

class EventDto {
  @IsString() @MinLength(3) @MaxLength(160) title: string;
  @IsOptional() @IsString() @MaxLength(1000) description?: string;
}

class StaffListQuery extends PageQuery {
  @IsOptional() @IsEnum(CaseStatus) status?: CaseStatus;
  @IsOptional() @IsEnum(CaseStage) stage?: CaseStage;
  @IsOptional() @IsString() search?: string;
  @IsOptional() @IsString() clientId?: string;
}

@Controller('cases')
export class CasesController {
  constructor(private readonly cases: CasesService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.cases.listOwn(user.id);
  }

  @Get(':id')
  detail(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.cases.detailOwn(user.id, id);
  }
}

@Controller('admin/cases')
@Roles(Role.SUPERADMIN, Role.LAWYER)
export class AdminCasesController {
  constructor(private readonly cases: CasesService) {}

  @Get()
  async list(@CurrentUser() actor: AuthUser, @Query() q: StaffListQuery) {
    const { page, pageSize, skip, take } = pageArgs(q);
    const { items, total } = await this.cases.listForStaff(actor, q, skip, take);
    return paged(items, total, page, pageSize);
  }

  @Post()
  create(@CurrentUser() actor: AuthUser, @Body() dto: CreateCaseDto) {
    return this.cases.create(actor, dto);
  }

  @Get(':id')
  detail(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.cases.detailForStaff(actor, id);
  }

  @Patch(':id')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateCaseDto) {
    return this.cases.update(actor, id, dto);
  }

  @Post(':id/events') @HttpCode(201)
  addEvent(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: EventDto) {
    return this.cases.addEvent(actor, id, dto);
  }

  @Post(':id/requirements') @HttpCode(201)
  addRequirement(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: RequirementDto) {
    return this.cases.addRequirement(actor, id, dto);
  }

  @Delete(':id/requirements/:requirementId')
  removeRequirement(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Param('requirementId') requirementId: string) {
    return this.cases.removeRequirement(actor, id, requirementId);
  }
}
