import { z } from 'zod';
import { APPLICANT_SOURCES } from '../hr/recruiting.js';

/**
 * The public driver application: a shareable link (usually behind an Instagram ad) that a driver
 * fills on a phone in about thirty seconds, and that arrives in HR → Recruiting as a lead.
 *
 * Three rules this contract holds:
 *
 *   - The company is never chosen by the client. A link is a server-side record; its slug is the
 *     only thing the browser sends, and the server reads the company off the link.
 *   - The answers are stored as given, beside the lead, never folded into it. A lead's own fields
 *     (name, phone) are the record a recruiter edits; the application is the evidence of what the
 *     driver said, when, and through which link and campaign.
 *   - The consent a driver agreed to is the link's own wording, written by the company. NeWay
 *     ships no legal text. A snapshot is kept with every application, so a later edit to the
 *     wording cannot change what an earlier applicant agreed to.
 *
 * The page asks four things, in the owner's design (design/apply/Driver-Application-Mobile.html):
 * full name, phone number, CDL driving experience and what the driver is looking for. The last two
 * are free text and are stored verbatim — never parsed into years, a CDL class or a pay type.
 */

// --------------------------------------------------------------------------------------- phone

/** `1` checks a North American number; `other` takes a whole international number with its code. */
export type PhoneDialCode = '1' | 'other';

export type PhoneResult = { ok: true; e164: string } | { ok: false; message: string };

/**
 * A phone number as E.164 (`+13125550142`), or the reason it is not one.
 *
 * North American numbers are checked against the numbering plan (area code and exchange cannot
 * start with 0 or 1), because a mistyped digit there is the most common way a lead becomes a
 * number nobody can call. A leading 1 is accepted and dropped. An international number whose
 * country code is 1 is a North American number and is checked as one.
 */
export function normalizePhone(dialCode: PhoneDialCode, input: string): PhoneResult {
  const digits = input.replace(/\D/g, '');
  if (digits.length === 0) return { ok: false, message: 'Enter your phone number' };

  const nanp = (ten: string): PhoneResult =>
    /^[2-9]\d{2}[2-9]\d{6}$/.test(ten)
      ? { ok: true, e164: `+1${ten}` }
      : { ok: false, message: 'Enter a valid 10-digit US or Canadian number' };

  if (dialCode === '1' || digits.startsWith('1')) {
    return nanp(digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits);
  }
  // The whole international number. E.164 allows at most 15 digits and no leading 0.
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    return { ok: false, message: 'Enter the full number with its country code' };
  }
  return { ok: true, e164: `+${digits}` };
}

/**
 * The phone number as the application page takes it: a number typed with a leading `+` is a full
 * international number, anything else is a US or Canadian number. Accepts and refuses exactly what
 * the page's own check (`phoneMessage` in apps/web/src/apply/phone-message.ts) does, with the
 * page's own wording, so a 422 from the server reads like the browser's message.
 */
export function normalizeApplyPhone(input: string): PhoneResult {
  const international = input.trim().startsWith('+');
  const result = normalizePhone(international ? 'other' : '1', input);
  if (result.ok) return result;
  const digits = input.replace(/\D/g, '');
  if (digits.length === 0) return { ok: false, message: 'Enter your phone number.' };
  return {
    ok: false,
    message:
      international && !digits.startsWith('1')
        ? 'Enter the full number with its country code.'
        : 'Enter a valid 10-digit phone number.',
  };
}

/**
 * The key two phone numbers are compared by: digits only, with a North American number given its
 * country code, so `(312) 555-0142`, `312.555.0142` and `+1 312 555 0142` are the same person.
 * The SQL twin is `LeadsService.phoneKeySql`.
 */
export function phoneMatchKey(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  return digits.length === 10 ? `1${digits}` : digits;
}

/** Trimmed and lower-cased; `null` when empty. */
export function normalizeEmail(input: string | null | undefined): string | null {
  const value = (input ?? '').trim().toLowerCase();
  return value === '' ? null : value;
}

/**
 * `"Juan  Carlos Perez"` → `Juan` / `Carlos Perez`. The first word is the first name and the rest
 * is the last name (empty for a one-word name); the full name stays on the application as typed.
 */
export function splitFullName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  const firstName = parts[0] ?? '';
  const lastName = parts.slice(1).join(' ');
  return { firstName, lastName };
}

// ------------------------------------------------------------------------------- the submission

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));

/** UTM and click ids read off the link the driver opened. Every one optional and bounded. */
export const ApplyAttributionSchema = z.object({
  utmSource: optionalText(200),
  utmMedium: optionalText(200),
  utmCampaign: optionalText(200),
  utmTerm: optionalText(200),
  utmContent: optionalText(200),
  fbclid: optionalText(500),
  gclid: optionalText(500),
  referrer: optionalText(500),
});
export type ApplyAttribution = z.infer<typeof ApplyAttributionSchema>;

/**
 * Where an online application actually came from, Instagram or Facebook, read from what the
 * browser carried (owner, 2026-10-06): the utm_source first (Meta's {{site_source_name}} gives
 * "ig" / "fb"), then the page that sent the driver. A Meta click id with no other sign is
 * Facebook. Anything else keeps the link's own source.
 */
export function sourceFromAttribution(
  attribution: Partial<ApplyAttribution> | null | undefined,
  fallback: string,
): string {
  // A link made for a job board, an agency or a referral keeps that source whatever it carries.
  if (!attribution || !['social', 'facebook', 'instagram', 'other', 'unknown'].includes(fallback)) {
    return fallback;
  }
  const utm = (attribution.utmSource ?? '').trim().toLowerCase();
  if (/^(ig|instagram)\b|instagram/.test(utm)) return 'instagram';
  if (/^(fb|facebook|meta)\b|facebook/.test(utm)) return 'facebook';
  const referrer = (attribution.referrer ?? '').toLowerCase();
  if (/(^|[/.])instagram\.com/.test(referrer)) return 'instagram';
  if (/(^|[/.])(facebook\.com|fb\.com|fb\.me)/.test(referrer)) return 'facebook';
  if (attribution.fbclid) return 'facebook';
  return fallback;
}

/**
 * What the browser posts: the design's four answers, the consent box, the honeypot and the
 * seconds the page showed. `submissionId` is minted once per filled-in form, in memory, and is
 * what makes a retry (a second tap, a dropped connection, a resend after an error) the same
 * submission rather than a second lead. `website` is the honeypot: hidden from people, filled by
 * bots. The messages are shown in the browser's own bubble on the field they name.
 */
export const PublicApplicationSchema = z.object({
  submissionId: z.uuid('Missing submission id'),
  fullName: z
    .string()
    .trim()
    .min(2, 'Enter your full name.')
    .max(100, 'Keep your name under 100 characters.'),
  phone: z.string().trim().min(1, 'Enter your phone number.').max(25, 'That number is too long.'),
  experience: z
    .string()
    .trim()
    .min(1, 'Tell us your CDL driving experience.')
    .max(80, 'Keep this under 80 characters.'),
  position: z
    .string()
    .trim()
    .min(1, 'Tell us what you are looking for.')
    .max(80, 'Keep this under 80 characters.'),
  consent: z.literal(true, { error: 'Please agree to be contacted so we can reply.' }),
  website: z.string().max(200).optional().default(''),
  completedInSeconds: z.number().int().min(0).max(3600).nullish(),
  attribution: ApplyAttributionSchema.optional().default({
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmTerm: null,
    utmContent: null,
    fbclid: null,
    gclid: null,
    referrer: null,
  }),
});
export type PublicApplicationInput = z.input<typeof PublicApplicationSchema>;
export type PublicApplication = z.output<typeof PublicApplicationSchema>;

/**
 * The answers as stored with the application: the name as typed (spaces collapsed), the phone as
 * E.164, the two free-text answers verbatim, and the seconds the page showed the driver.
 */
export const ApplicationAnswersSchema = z.object({
  fullName: z.string(),
  phone: z.string(),
  experience: z.string(),
  position: z.string(),
  completedInSeconds: z.number().int().nullable(),
});
export type ApplicationAnswers = z.infer<typeof ApplicationAnswersSchema>;

/** The only thing the public endpoint says back: it was saved. Nothing about any lead. */
export const PublicApplicationReceiptSchema = z.object({
  status: z.literal('received'),
});
export type PublicApplicationReceipt = z.infer<typeof PublicApplicationReceiptSchema>;

/** What the public page needs to draw itself. No candidate data, ever. */
export const PublicApplyConfigSchema = z.object({
  companyName: z.string(),
  /** Shown as "Drive with …"; the page falls back to the company name. */
  shortName: z.string().nullable(),
  logoUrl: z.string().nullable(),
  consentText: z.string(),
  privacyPolicyUrl: z.string(),
});
export type PublicApplyConfig = z.infer<typeof PublicApplyConfigSchema>;

// ---------------------------------------------------------------------------------------- links

export const APPLY_LINK_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])$/;

const isHttps = (v: string): boolean => {
  try {
    return new URL(v).protocol === 'https:';
  } catch {
    return false;
  }
};

const httpsUrl = (message: string) => z.string().trim().max(500).refine(isHttps, message);

/**
 * A logo address: https://, or a path on this site (`/brand/nwf-logo.png`). A path starting `//`
 * is another host in disguise and is refused, as is anything with a scheme other than https.
 */
const logoUrl = z
  .string()
  .trim()
  .max(500)
  .refine(
    (v) => isHttps(v) || /^\/(?!\/)[A-Za-z0-9._~\-/%]+$/.test(v),
    'Use an https:// image address or a path on this site starting with /',
  );

export const ApplyLinkSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  shortName: z.string().nullable(),
  source: z.enum(APPLICANT_SOURCES),
  campaignId: z.string().nullable(),
  campaignName: z.string().nullable(),
  logoUrl: z.string().nullable(),
  consentText: z.string(),
  privacyPolicyUrl: z.string(),
  active: z.boolean(),
  applicationCount: z.number().int(),
  lastApplicationAt: z.string().nullable(),
  createdAt: z.string(),
});
export type ApplyLink = z.infer<typeof ApplyLinkSchema>;

export const CreateApplyLinkSchema = z.object({
  name: z.string().trim().min(1, 'Give the link a name').max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(APPLY_LINK_SLUG_PATTERN, '3–48 characters: lowercase letters, digits and dashes'),
  shortName: z
    .string()
    .trim()
    .max(12, 'Up to 12 characters')
    .nullish()
    .transform((v) => v || null),
  source: z.enum(APPLICANT_SOURCES).default('social'),
  campaignId: z
    .string()
    .nullish()
    .transform((v) => v || null),
  logoUrl: logoUrl
    .nullish()
    .or(z.literal(''))
    .transform((v) => v || null),
  consentText: z
    .string()
    .trim()
    .min(20, 'Paste the consent wording your company has approved')
    .max(1000),
  privacyPolicyUrl: httpsUrl('Use the https:// address of your privacy policy'),
});
export type CreateApplyLinkInput = z.input<typeof CreateApplyLinkSchema>;

export const UpdateApplyLinkSchema = CreateApplyLinkSchema.omit({ slug: true })
  .partial()
  .extend({ active: z.boolean().optional() });
export type UpdateApplyLinkInput = z.input<typeof UpdateApplyLinkSchema>;

// ------------------------------------------------------------------- what HR sees on the lead

export const LeadApplicationSchema = z.object({
  id: z.string(),
  leadId: z.string(),
  receivedAt: z.string(),
  /** `new_lead` when this application created the lead; `existing_lead` when it joined one. */
  outcome: z.enum(['new_lead', 'existing_lead']),
  link: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  source: z.string(),
  campaignId: z.string().nullable(),
  campaignName: z.string().nullable(),
  /** `null` for an application stored in an earlier format, which the screen says in words. */
  answers: ApplicationAnswersSchema.nullable(),
  attribution: ApplyAttributionSchema,
  consent: z.object({
    text: z.string(),
    privacyPolicyUrl: z.string(),
    agreedAt: z.string(),
  }),
});
export type LeadApplication = z.infer<typeof LeadApplicationSchema>;

/**
 * The latest application's two free-text answers, carried on the lead so a list can show them.
 * `experience` and `position` are `null` when that application is in an earlier format.
 */
export const LeadApplicationSummarySchema = z.object({
  receivedAt: z.string(),
  linkName: z.string(),
  experience: z.string().nullable(),
  position: z.string().nullable(),
});
export type LeadApplicationSummary = z.infer<typeof LeadApplicationSummarySchema>;
