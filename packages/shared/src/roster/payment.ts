import { z } from 'zod';

/**
 * Accounting & payment details on the driver profile (owner's brief, 2026-09-21).
 *
 * What is stored is how the driver is paid; what is served is the same with the account and
 * routing numbers masked to their last four digits. There is no "show" - a wrong number is
 * replaced, never revealed - which is the product's rule for every secret.
 */
export const PAYMENT_METHODS = ['ach', 'wire', 'check', 'zelle', 'paypal', 'other'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];
export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  ach: 'ACH / direct deposit',
  wire: 'Wire transfer',
  check: 'Check',
  zelle: 'Zelle',
  paypal: 'PayPal',
  other: 'Other',
};

export const BANK_ACCOUNT_TYPES = ['checking', 'savings', 'business'] as const;
export type BankAccountType = (typeof BANK_ACCOUNT_TYPES)[number];
export const BANK_ACCOUNT_TYPE_LABEL: Record<BankAccountType, string> = {
  checking: 'Checking',
  savings: 'Savings',
  business: 'Business',
};

export const PAY_FREQUENCIES = ['weekly', 'biweekly', 'monthly', 'per_load'] as const;
export type PayFrequency = (typeof PAY_FREQUENCIES)[number];
export const PAY_FREQUENCY_LABEL: Record<PayFrequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Every two weeks',
  monthly: 'Monthly',
  per_load: 'Per load',
};

export const CURRENCIES = ['USD', 'CAD', 'MXN'] as const;

/** What the profile shows. Numbers arrive masked; the flags say whether one is on file. */
export const DriverPaymentDetailsSchema = z.object({
  driverId: z.string(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  payeeName: z.string().nullable(),
  bankName: z.string().nullable(),
  accountType: z.enum(BANK_ACCOUNT_TYPES).nullable(),
  /** `••••1234`, or null when none is on file. */
  routingNumberMasked: z.string().nullable(),
  accountNumberMasked: z.string().nullable(),
  currency: z.string(),
  payFrequency: z.enum(PAY_FREQUENCIES),
  authorization: z
    .object({ fileId: z.string(), fileName: z.string(), url: z.string() })
    .nullable(),
  version: z.number().int(),
  updatedBy: z.string(),
  updatedAt: z.string(),
});
export type DriverPaymentDetails = z.infer<typeof DriverPaymentDetailsSchema>;

/**
 * Saving. A number left out keeps what is on file; a number given replaces it. The version is the
 * one the form was opened with, so two people cannot silently overwrite each other.
 */
export const SaveDriverPaymentSchema = z.object({
  version: z.number().int().nullable(),
  paymentMethod: z.enum(PAYMENT_METHODS),
  payeeName: z.string().trim().max(120).nullable().default(null),
  bankName: z.string().trim().max(120).nullable().default(null),
  accountType: z.enum(BANK_ACCOUNT_TYPES).nullable().default(null),
  routingNumber: z
    .string()
    .trim()
    .regex(/^\d{9}$/, 'A routing number is nine digits')
    .optional(),
  accountNumber: z
    .string()
    .trim()
    .regex(/^[0-9A-Za-z-]{4,34}$/, 'An account number is 4 to 34 characters')
    .optional(),
  currency: z.enum(CURRENCIES).default('USD'),
  payFrequency: z.enum(PAY_FREQUENCIES).default('weekly'),
  /** A stored file's id, from the upload; null clears it. */
  authorizationFileId: z.string().nullable().optional(),
  authorizationFileName: z.string().trim().max(200).nullable().optional(),
});
export type SaveDriverPaymentInput = z.infer<typeof SaveDriverPaymentSchema>;
export type SaveDriverPaymentRequest = z.input<typeof SaveDriverPaymentSchema>;

export function maskNumber(value: string | null | undefined): string | null {
  if (!value) return null;
  return `••••${value.slice(-4)}`;
}
