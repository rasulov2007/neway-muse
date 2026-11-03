import { zodResolver } from '@hookform/resolvers/zod';
import {
  useForm,
  type FieldValues,
  type Resolver,
  type UseFormProps,
  type UseFormReturn,
} from 'react-hook-form';
import type { z } from 'zod';

export type ZodFormSchema = z.ZodType<FieldValues, FieldValues>;

export type UseZodFormOptions<TSchema extends ZodFormSchema> = Omit<
  UseFormProps<z.input<TSchema>, unknown, z.output<TSchema>>,
  'resolver'
>;

/** react-hook-form bound to a zod schema. Validates on blur first, then on every change. */
export function useZodForm<TSchema extends ZodFormSchema>(
  schema: TSchema,
  options?: UseZodFormOptions<TSchema>,
): UseFormReturn<z.input<TSchema>, unknown, z.output<TSchema>> {
  // The resolver's overloads resolve against the generic constraint, not the concrete schema,
  // so the input/output pair has to be restated here.
  const resolver = zodResolver(schema) as unknown as Resolver<
    z.input<TSchema>,
    unknown,
    z.output<TSchema>
  >;
  return useForm<z.input<TSchema>, unknown, z.output<TSchema>>({
    mode: 'onTouched',
    ...options,
    resolver,
  });
}
