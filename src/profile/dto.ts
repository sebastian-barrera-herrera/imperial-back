import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class UpdateProfileDto {
  @IsOptional() @Transform(trim) @IsString() @MinLength(3) @MaxLength(120)
  fullName?: string;

  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @Matches(/^[A-Z0-9.\-]{5,20}$/, { message: 'La cédula debe tener entre 5 y 20 caracteres (letras, números, punto o guion)' })
  cedula?: string;

  @IsOptional() @Transform(trim) @Matches(/^\+?[0-9 ()\-]{7,20}$/, { message: 'Número de teléfono inválido' })
  phone?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(200)
  address?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(80)
  city?: string;

  @IsOptional() @Transform(trim) @IsString() @MaxLength(80)
  bankName?: string;

  @IsOptional() @IsIn(['SAVINGS', 'CHECKING'])
  accountType?: string;

  @IsOptional() @Transform(trim) @Matches(/^[0-9][0-9 \-]{5,29}$/, { message: 'Número de cuenta inválido (solo dígitos, 6 a 30)' })
  accountNumber?: string;
}
