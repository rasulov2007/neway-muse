import { z } from 'zod';
import { US_STATES, VIN_PATTERN } from './TruckFormSchema';

/**
 * Only the identity is required: trailer number, VIN, model, year, type (no make: owner, 2026-10-22). Length, plate, ownership
 * and the inspection date are known some time after the trailer is, and each is added from the
 * trailer's page later; the feature that needs it asks for it there.
 */
export const trailerFormSchema = z.object({
  unitNumber: z
    .string()
    .trim()
    .min(2, 'Trailer number needs at least 2 characters')
    .max(8, 'Trailer number can be at most 8 characters'),
  vin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(VIN_PATTERN, 'VIN must be 17 characters with no I, O or Q'),
  year: z
    .string()
    .trim()
    .min(1, 'Year is required')
    .transform(Number)
    .pipe(
      z
        .number({ error: 'Year must be a number' })
        .int()
        .min(1990, 'Year must be 1990 or later')
        .max(2027, 'Year must be 2027 or earlier'),
    ),
  // Model in place of Make; the form does not ask for a make at all (owner, 2026-10-22).
  model: z.string().trim().min(1, 'Model is required').max(40, 'Model is too long'),
  type: z.enum(['dry_van', 'reefer', 'flatbed'], { error: 'Select a type' }),
  /** Blank means "not measured yet"; a value must be a real trailer length. */
  lengthFt: z
    .string()
    .trim()
    .transform((value) => (value === '' ? undefined : Number(value)))
    .pipe(
      z
        .number({ error: 'Length must be a number' })
        .int('Length must be a whole number')
        .min(20, 'Length must be 20 ft or more')
        .max(60, 'Length must be 60 ft or less')
        .optional(),
    ),
  plate: z
    .string()
    .trim()
    .max(10, 'Plate is too long')
    .transform((value) => (value === '' ? undefined : value)),
  plateState: z.enum(US_STATES, { error: 'Select the plate state' }).optional(),
  ownership: z.enum(['owned', 'leased'], { error: 'Select ownership' }).optional(),
  nextInspectionDate: z.date().optional(),
});

export type TrailerFormInput = z.input<typeof trailerFormSchema>;
export type TrailerFormValues = z.output<typeof trailerFormSchema>;

export const trailerFormDefaults: TrailerFormInput = {
  unitNumber: '',
  vin: '',
  year: '',
  model: '',
  type: undefined as unknown as TrailerFormInput['type'],
  lengthFt: '',
  plate: '',
  plateState: undefined,
  // Company owned is what the rest of the product assumes, so it is preselected.
  ownership: 'owned',
  nextInspectionDate: undefined,
};
