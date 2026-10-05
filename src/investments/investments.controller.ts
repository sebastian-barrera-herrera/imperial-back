import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { InterestStatus, InvestmentStatus, OpportunityStatus, RiskLevel, Role } from '@prisma/client';
import { IsEnum, IsIn, IsInt, IsNumber, IsOptional, IsString, Matches, Max, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/types';
import { InvestmentsService } from './investments.service';
import { simulate } from './simulator';

class SimulateDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(999_999_999_999)
  principal: number;

  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(100)
  annualRate: number;

  @IsInt() @Min(1) @Max(120)
  termMonths: number;

  @IsIn(['COMPOUND', 'SIMPLE'])
  mode: 'COMPOUND' | 'SIMPLE';
}

class InterestDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(999_999_999_999) amount: number;
  @IsOptional() @IsString() @MaxLength(500) message?: string;
}

class OpportunityDto {
  @IsString() @MinLength(3) @MaxLength(160) title: string;
  @IsString() @MinLength(10) @MaxLength(1000) summary: string;
  @IsString() @MinLength(10) @MaxLength(8000) terms: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(999_999_999_999) minAmount: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Max(999_999_999_999) maxAmount?: number | null;
  @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(100) annualRate: number;
  @IsInt() @Min(1) @Max(120) termMonths: number;
  @IsEnum(RiskLevel) risk: RiskLevel;
  @IsOptional() @IsEnum(OpportunityStatus) status?: OpportunityStatus;
}

class UpdateOpportunityDto {
  @IsOptional() @IsString() @MinLength(3) @MaxLength(160) title?: string;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(1000) summary?: string;
  @IsOptional() @IsString() @MinLength(10) @MaxLength(8000) terms?: string;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(999_999_999_999) minAmount?: number;
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Max(999_999_999_999) maxAmount?: number | null;
  @IsOptional() @IsNumber({ maxDecimalPlaces: 3 }) @Min(0.001) @Max(100) annualRate?: number;
  @IsOptional() @IsInt() @Min(1) @Max(120) termMonths?: number;
  @IsOptional() @IsEnum(RiskLevel) risk?: RiskLevel;
  @IsOptional() @IsEnum(OpportunityStatus) status?: OpportunityStatus;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MESSAGE = 'La fecha debe tener el formato AAAA-MM-DD';

class ValuationDto {
  @Matches(DAY, { message: DAY_MESSAGE }) date: string;
  @IsNumber({ maxDecimalPlaces: 4 }) @Min(0.0001) @Max(1_000_000) unitValue: number;
  @IsOptional() @IsString() @MaxLength(200) note?: string;
}

class PositionDto {
  @IsString() userId: string;
  @IsString() opportunityId: string;
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(1) @Max(999_999_999_999) amount: number;
  @IsOptional() @Matches(DAY, { message: DAY_MESSAGE }) investedAt?: string;
}

class RedeemDto {
  @IsOptional() @Matches(DAY, { message: DAY_MESSAGE }) date?: string;
}

class PositionsQuery {
  @IsOptional() @IsEnum(InvestmentStatus) status?: InvestmentStatus;
  @IsOptional() @IsString() opportunityId?: string;
  @IsOptional() @IsString() userId?: string;
}

class InterestStatusDto {
  @IsEnum(InterestStatus) status: InterestStatus;
}

class InterestsQuery {
  @IsOptional() @IsEnum(InterestStatus) status?: InterestStatus;
}

@Controller('investments')
export class InvestmentsController {
  constructor(private readonly investments: InvestmentsService) {}

  @Get('opportunities')
  list() {
    return this.investments.listOpen();
  }

  @Get('opportunities/:id')
  get(@Param('id') id: string) {
    return this.investments.getOpen(id);
  }

  @Get('opportunities/:id/performance')
  performance(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.investments.performance(user, id);
  }

  /** Portafolio del cliente: posiciones, valor actual, ganancias, asignación e historial. */
  @Get('portfolio')
  portfolio(@CurrentUser() user: AuthUser) {
    return this.investments.portfolio(user.id);
  }

  @Post('simulate') @HttpCode(200)
  simulate(@Body() dto: SimulateDto) {
    return simulate(dto);
  }

  @Post('opportunities/:id/interest')
  interest(@CurrentUser() user: AuthUser, @Param('id') id: string, @Body() dto: InterestDto) {
    return this.investments.expressInterest(user, id, dto);
  }

  @Get('interests')
  myInterests(@CurrentUser() user: AuthUser) {
    return this.investments.listOwnInterests(user.id);
  }
}

@Controller('admin/investments')
@Roles(Role.SUPERADMIN)
export class AdminInvestmentsController {
  constructor(private readonly investments: InvestmentsService) {}

  @Get('opportunities')
  list() {
    return this.investments.listAll();
  }

  @Post('opportunities')
  create(@CurrentUser() actor: AuthUser, @Body() dto: OpportunityDto) {
    return this.investments.create(actor, dto);
  }

  @Patch('opportunities/:id')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateOpportunityDto) {
    return this.investments.update(actor, id, dto);
  }

  @Delete('opportunities/:id')
  remove(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.investments.remove(actor, id);
  }

  @Get('opportunities/:id/valuations')
  valuations(@Param('id') id: string) {
    return this.investments.listValuations(id);
  }

  @Post('opportunities/:id/valuations')
  addValuation(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: ValuationDto) {
    return this.investments.addValuation(actor, id, dto);
  }

  @Delete('opportunities/:id/valuations/:valuationId')
  removeValuation(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Param('valuationId') valuationId: string) {
    return this.investments.removeValuation(actor, id, valuationId);
  }

  @Get('summary')
  summary() {
    return this.investments.summary();
  }

  @Get('positions')
  positions(@Query() q: PositionsQuery) {
    return this.investments.listPositions(q);
  }

  @Post('positions')
  createPosition(@CurrentUser() actor: AuthUser, @Body() dto: PositionDto) {
    return this.investments.createPosition(actor, dto);
  }

  @Post('positions/:id/redeem') @HttpCode(200)
  redeem(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: RedeemDto) {
    return this.investments.redeemPosition(actor, id, dto.date);
  }

  @Get('interests')
  interests(@Query() q: InterestsQuery) {
    return this.investments.listInterests(q.status);
  }

  @Patch('interests/:id')
  setInterestStatus(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: InterestStatusDto) {
    return this.investments.setInterestStatus(actor, id, dto.status);
  }
}
