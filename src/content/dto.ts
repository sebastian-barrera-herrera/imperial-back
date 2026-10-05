import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, Length } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** Confirmación de que la persona es real y autorizó por escrito publicar su nombre, opinión y foto. */
class Authorization {
  @IsOptional() @IsBoolean() authorized?: boolean;
}

export class CreateTeamDto extends Authorization {
  @Transform(trim) @IsString() @Length(2, 120) name: string;
  @Transform(trim) @IsString() @Length(2, 160) role: string;
  @Transform(trim) @IsString() @Length(2, 400) bio: string;
  @IsOptional() @IsString() photoId?: string;
  @IsOptional() @IsBoolean() published?: boolean;
}

export class UpdateTeamDto extends Authorization {
  @IsOptional() @Transform(trim) @IsString() @Length(2, 120) name?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(2, 160) role?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(2, 400) bio?: string;
  /** `null` quita la foto; si se omite no cambia. */
  @IsOptional() @IsString() photoId?: string | null;
  @IsOptional() @IsBoolean() published?: boolean;
}

export class CreateTestimonialDto extends Authorization {
  @Transform(trim) @IsString() @Length(10, 600) quote: string;
  @Transform(trim) @IsString() @Length(2, 120) author: string;
  @Transform(trim) @IsString() @Length(2, 80) kind: string;
  @IsOptional() @IsString() photoId?: string;
  @IsOptional() @IsBoolean() published?: boolean;
}

export class UpdateTestimonialDto extends Authorization {
  @IsOptional() @Transform(trim) @IsString() @Length(10, 600) quote?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(2, 120) author?: string;
  @IsOptional() @Transform(trim) @IsString() @Length(2, 80) kind?: string;
  @IsOptional() @IsString() photoId?: string | null;
  @IsOptional() @IsBoolean() published?: boolean;
}

export class OrderDto {
  @IsArray() @ArrayMaxSize(200) @IsString({ each: true }) ids: string[];
}
