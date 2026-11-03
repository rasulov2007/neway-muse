import { Injectable, type PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { AppError } from '../errors/app-error';

/** One field-level validation failure, as rendered in the problem body `errors[]`. */
export interface ValidationIssue {
  path: string;
  message: string;
  code: string;
}

/** Validates a request part with a zod schema; failures become 422 problem+json with `errors[]`. */
@Injectable()
export class ZodValidationPipe<T extends z.ZodType> implements PipeTransform<unknown, z.output<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown): z.output<T> {
    const result = this.schema.safeParse(value ?? {});
    if (result.success) return result.data;
    const errors: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.map(String).join('.'),
      message: issue.message,
      code: issue.code,
    }));
    throw new AppError({
      status: 422,
      title: 'Unprocessable Entity',
      detail: errors.map((e) => (e.path ? `${e.path}: ${e.message}` : e.message)).join('; '),
      extensions: { errors },
    });
  }
}
