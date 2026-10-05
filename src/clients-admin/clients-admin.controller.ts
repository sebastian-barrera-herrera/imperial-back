import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import { Role } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsNumber, IsOptional, IsString, Length, Matches, Max, MaxLength, Min } from 'class-validator';
import { CurrentUser, Roles } from '../common/decorators';
import { AuthUser } from '../common/types';
import { ClientsAdminService } from './clients-admin.service';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const emptyToUndefined = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() || undefined : value);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

class DeactivateDto {
  @Transform(trim) @IsString() @Length(3, 300) reason: string;
}

class AdvisorDto {
  /** `null` quita el asesor asignado. */
  @IsOptional() @IsString() advisorId?: string | null;
}

class CreateDepositDto {
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(999_999_999_999) amount: number;
  @Matches(DATE, { message: 'La fecha debe tener el formato AAAA-MM-DD' }) depositedAt: string;
  @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @Transform(emptyToUndefined) @IsString() @MaxLength(300) note?: string;
}

class UpdateDepositDto {
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) @Max(999_999_999_999) amount?: number;
  @IsOptional() @Matches(DATE, { message: 'La fecha debe tener el formato AAAA-MM-DD' }) depositedAt?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(80) reference?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(300) note?: string;
}

/** El superadmin da de baja o reactiva clientes, les asigna asesor y registra sus depósitos. */
@Controller('admin/clients')
@Roles(Role.SUPERADMIN)
export class AdminClientsController {
  constructor(private readonly clients: ClientsAdminService) {}

  @Post(':id/deactivate') @HttpCode(200)
  deactivate(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: DeactivateDto) {
    return this.clients.deactivate(actor, id, dto.reason);
  }

  @Post(':id/reactivate') @HttpCode(200)
  reactivate(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.clients.reactivate(actor, id);
  }

  @Patch(':id/advisor')
  setAdvisor(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: AdvisorDto) {
    return this.clients.setAdvisor(actor, id, dto.advisorId ?? null);
  }

  @Get(':id/deposits')
  deposits(@Param('id') id: string) {
    return this.clients.listDeposits(id);
  }

  @Post(':id/deposits')
  createDeposit(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: CreateDepositDto) {
    return this.clients.createDeposit(actor, id, dto);
  }
}

@Controller('admin/deposits')
@Roles(Role.SUPERADMIN)
export class AdminDepositsController {
  constructor(private readonly clients: ClientsAdminService) {}

  @Patch(':id')
  update(@CurrentUser() actor: AuthUser, @Param('id') id: string, @Body() dto: UpdateDepositDto) {
    return this.clients.updateDeposit(actor, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() actor: AuthUser, @Param('id') id: string) {
    return this.clients.removeDeposit(actor, id);
  }
}

/** Lo que ve el cliente: su asesor profesional y sus depósitos. */
@Controller()
@Roles(Role.CLIENT)
export class ClientSelfController {
  constructor(private readonly clients: ClientsAdminService) {}

  @Get('advisor')
  advisor(@CurrentUser() user: AuthUser) {
    return this.clients.advisorFor(user.id);
  }

  @Get('deposits')
  deposits(@CurrentUser() user: AuthUser) {
    return this.clients.ownDeposits(user.id);
  }
}
