import { z } from 'zod';

/**
 * Adding a broker.
 *
 * The MC number is required and must be unique, because it is how a broker is identified on a rate
 * confirmation and how duplicates creep into a carrier's books. Payment terms are required because
 * the risk engine measures days-to-pay against them; without terms there is nothing to be late
 * against.
 *
 * Nothing that has to be earned is collected here — no rating, no volume, no profitability. Those
 * are computed from the freight the broker actually gives you.
 */

const requiredText = (field: string) => z.string().trim().min(1, `${field} is required`);

const stateCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use the two-letter state code');

/** `MC-123456` or `123456`; normalised to the `MC-` form on submit. */
export const MC_PATTERN = /^(MC-?)?\d{4,8}$/i;

export const PAYMENT_TERMS = [
  { value: '15', label: 'Net 15' },
  { value: '21', label: 'Net 21' },
  { value: '30', label: 'Net 30' },
  { value: '45', label: 'Net 45' },
  { value: '60', label: 'Net 60' },
] as const;

export const brokerFormSchema = z
  .object({
    name: requiredText('Broker name'),
    // Optional (owner, 2026-10-13); when given it still has to look like an MC number.
    mcNumber: z
      .string()
      .trim()
      .refine((v) => v === '' || MC_PATTERN.test(v), 'Enter an MC number such as MC-123456'),
    usdot: z
      .string()
      .trim()
      .regex(/^\d{5,8}$/, 'USDOT is 5 to 8 digits')
      .optional()
      .or(z.literal('')),
    addressLine1: requiredText('Street address'),
    city: requiredText('City'),
    state: stateCode,
    zip: z
      .string()
      .trim()
      .regex(/^\d{5}(-\d{4})?$/, 'Enter a 5-digit ZIP'),
    paymentTermsDays: z.coerce.number().int().min(1).max(120),
    contactName: requiredText('Contact name'),
    contactEmail: z.string().trim().email('Enter a valid email address'),
    contactPhone: requiredText('Contact phone').regex(
      /^[+\d(][\d\s()-]{6,}$/,
      'Enter a phone number the broker can be reached on',
    ),
    doNotUse: z.boolean(),
    doNotUseReason: z.string().trim().max(200).optional(),
  })
  .superRefine((values, ctx) => {
    // A do-not-use flag with no reason is useless to whoever reads it later; the risk engine quotes
    // this text verbatim as the whole explanation for a high-risk grade.
    if (values.doNotUse && !values.doNotUseReason?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['doNotUseReason'],
        message: 'Record why, so the reason shows on the broker risk grade',
      });
    }
  });

export type BrokerFormValues = z.infer<typeof brokerFormSchema>;

/** `123456` and `mc123456` both become `MC-123456`, so the uniqueness check is meaningful. */
export function normalizeMc(value: string): string {
  const digits = value.replace(/\D/g, '');
  return digits ? `MC-${digits}` : '';
}
