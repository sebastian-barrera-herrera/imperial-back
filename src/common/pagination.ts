import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class PageQuery {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1)
  page?: number = 1;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100)
  pageSize?: number = 20;
}

export const pageArgs = (q: PageQuery) => {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 20;
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
};

export const paged = <T>(items: T[], total: number, page: number, pageSize: number) => ({ items, total, page, pageSize });
