import { Transform } from 'class-transformer';
import { Equals, IsEmail, IsString, Matches, MaxLength, MinLength } from 'class-validator';

const lower = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toLowerCase() : value);
export const PASSWORD_RULE = /^(?=.*[A-Za-z])(?=.*\d).{10,72}$/;
export const PASSWORD_MESSAGE = 'La contraseña debe tener entre 10 y 72 caracteres, con al menos una letra y un número';

export class RegisterDto {
  @IsString() @MinLength(3) @MaxLength(120) @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  fullName: string;

  @Transform(lower) @IsEmail() @MaxLength(160)
  email: string;

  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  password: string;

  // Consentimiento expreso: sin él no se crea la cuenta (queda registrado con fecha y versión).
  @Equals(true, { message: 'Debes aceptar el aviso y la política de privacidad para crear tu cuenta' })
  acceptPrivacy: boolean;
}

export class LoginDto {
  @Transform(lower) @IsEmail()
  email: string;

  @IsString() @MaxLength(72)
  password: string;
}

export class ChangePasswordDto {
  @IsString() @MaxLength(72)
  currentPassword: string;

  @Matches(PASSWORD_RULE, { message: PASSWORD_MESSAGE })
  newPassword: string;
}
