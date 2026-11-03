import { z } from 'zod';
import { CdlExtractSchema, type CdlExtract } from './cdl-extract.js';

/**
 * Reading a CDL with Meta Muse (hackathon, 2026-11-03).
 *
 * The licence photo goes to the model; what comes back is a *proposal*: every field with how sure
 * the model was, plus warnings where the card disagrees with what the candidate typed in the DOT
 * application. Nothing here is saved. The recruiter checks the fields against the card, corrects
 * what is wrong, and only the upload they confirm carries the reading into the driver file.
 */

export const CDL_READ_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;

export const ReadCdlRequestSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  contentType: z.enum(CDL_READ_TYPES),
  /** The file as base64, or a data URL. */
  content: z.string().min(1),
});
export type ReadCdlRequest = z.infer<typeof ReadCdlRequestSchema>;

/** The fields read off the front of a licence, in the order the screen shows them. */
export const CDL_READ_FIELDS = [
  'legalFirstName',
  'legalMiddleName',
  'legalLastName',
  'dateOfBirth',
  'cdlNumber',
  'issuingState',
  'cdlClass',
  'endorsements',
  'restrictions',
  'cdlIssuedOn',
  'cdlExpiresOn',
] as const;
export type CdlReadField = (typeof CDL_READ_FIELDS)[number];

/** Below this the field is marked for a person to check against the card. */
export const CDL_REVIEW_BELOW = 0.8;

const read = <T extends z.ZodType>(value: T) =>
  z.object({ value, confidence: z.number().describe('0 to 1: how sure you are this value is right') });

/** What Muse is held to: every field as { value, confidence }. Dates as printed or YYYY-MM-DD. */
export const CdlMuseAnswerSchema = z.object({
  isDriverLicence: z.boolean().describe('true when the image is a driver licence of any kind'),
  isCommercial: z.boolean().describe('true when it is a commercial driver licence (CDL)'),
  legalFirstName: read(z.string().nullable()),
  legalMiddleName: read(z.string().nullable()),
  legalLastName: read(z.string().nullable()),
  dateOfBirth: read(z.string().nullable().describe('YYYY-MM-DD')),
  cdlNumber: read(z.string().nullable()),
  issuingState: read(z.string().nullable().describe('two-letter state code')),
  cdlClass: read(z.string().nullable().describe('A, B or C')),
  endorsements: read(z.array(z.string()).describe('endorsement letters, e.g. ["N","T"]; [] when NONE')),
  restrictions: read(z.array(z.string()).describe('restriction codes, e.g. ["L"]; [] when NONE')),
  cdlIssuedOn: read(z.string().nullable().describe('YYYY-MM-DD')),
  cdlExpiresOn: read(z.string().nullable().describe('YYYY-MM-DD')),
});
export type CdlMuseAnswer = z.infer<typeof CdlMuseAnswerSchema>;

export const CDL_MUSE_INSTRUCTIONS = `You read the front of a US driver licence (usually a commercial driver licence, CDL) from a photo or scan and copy what it says into a form.

Copy values exactly as printed. When the card does not show something or you cannot read it, return null (or [] for lists) - never guess. Give every field a confidence from 0 to 1: 1 = clearly printed and read, below 0.8 = blurry, cut off, ambiguous or inferred.

- Names: the licence prints the last name first on many states ("1 DOE" / "2 JANE MARIE"): legalLastName is field 1, legalFirstName the first word of field 2, legalMiddleName the rest (null when none).
- Dates: return YYYY-MM-DD. US cards print MM/DD/YYYY. dateOfBirth is DOB; cdlIssuedOn is ISS; cdlExpiresOn is EXP.
- cdlNumber: the DL / LIC / CDL number, without its label.
- issuingState: the two-letter code of the state that issued the card.
- cdlClass: A, B or C only (from CLASS). endorsements (END): letters such as H, N, P, S, T, X; [] when NONE. restrictions (REST): codes such as B, E, K, L, M, N, O, V, Z; [] when NONE.
- isDriverLicence: false when the image is not a driver licence at all. isCommercial: true only for a commercial licence (CDL).`;

/** What the candidate typed in the DOT application, for the comparison. */
export interface CdlApplicationFacts {
  legalFirstName: string | null;
  legalLastName: string | null;
  dateOfBirth: string | null;
  licences: { state: string; number: string; expiresOn: string | null }[];
}

export type CdlReadWarningTone = 'urgent' | 'warning' | 'info';
export interface CdlReadWarning {
  field: CdlReadField | 'document';
  tone: CdlReadWarningTone;
  message: string;
}

export interface CdlReadResult {
  /** The proposal, in the shape the driver file keeps (source `ocr`, unsure fields in needsReview). */
  extract: CdlExtract;
  /** 0..1 per field, as the model gave it. */
  confidence: Record<CdlReadField, number>;
  warnings: CdlReadWarning[];
  /** True when there was a DOT application to compare the card with. */
  compared: boolean;
  model: string;
  /** How long the read took, in milliseconds. */
  ms: number;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
const US = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/;

/** A printed date as YYYY-MM-DD, or null when it is not a real calendar date. Never via a time zone. */
export function cdlDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value.trim();
  let y: number, m: number, d: number;
  const iso = text.match(ISO);
  const us = text.match(US);
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
  else if (us) [y, m, d] = [Number(us[3]), Number(us[1]), Number(us[2])];
  else return null;
  if (m < 1 || m > 12 || d < 1 || y < 1900 || y > 2100) return null;
  const days = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  if (d > days) return null;
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function codes(values: string[], max: number): string[] {
  const out: string[] = [];
  for (const raw of values) {
    for (const part of raw.toUpperCase().split(/[\s,;/]+/)) {
      const code = part.replace(/[^A-Z0-9]/g, '');
      if (!code || code === 'NONE' || code === 'NA' || code.length > 3) continue;
      if (!out.includes(code)) out.push(code);
    }
  }
  return out.slice(0, max);
}

function text(value: string | null, max: number): string | null {
  const t = value?.replace(/\s+/g, ' ').trim() ?? '';
  return t ? t.slice(0, max) : null;
}

function clampConfidence(n: number): number {
  if (!Number.isFinite(n)) return 0;
  const v = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, Math.round(v * 100) / 100));
}

/** Names compared as letters only, case and accents ignored ("O'Neil" = "ONEIL"). */
export function sameName(a: string | null, b: string | null): boolean {
  const n = (s: string | null) =>
    (s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z]/g, '');
  return n(a) !== '' && n(a) === n(b);
}

const sameNumber = (a: string, b: string) => a.replace(/[^A-Z0-9]/gi, '').toUpperCase() === b.replace(/[^A-Z0-9]/gi, '').toUpperCase();

function plusDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/**
 * Muse's answer → the proposal the screen shows. Pure: `today` is the server's Eastern date.
 */
export function cdlReadingFromAnswer(
  answer: CdlMuseAnswer,
  options: { application: CdlApplicationFacts | null; today: string; reviewBelow?: number },
): Omit<CdlReadResult, 'model' | 'ms'> {
  const below = options.reviewBelow ?? CDL_REVIEW_BELOW;
  const confidence = Object.fromEntries(
    CDL_READ_FIELDS.map((f) => [f, clampConfidence(answer[f].confidence)]),
  ) as Record<CdlReadField, number>;

  const cls = answer.cdlClass.value?.toUpperCase().match(/\b(?:CLASS\s*)?([ABC])\b/)?.[1] ?? null;
  const state = answer.issuingState.value?.trim().toUpperCase() ?? '';
  const raw = {
    legalFirstName: text(answer.legalFirstName.value, 60),
    legalMiddleName: text(answer.legalMiddleName.value, 60),
    legalLastName: text(answer.legalLastName.value, 60),
    dateOfBirth: cdlDate(answer.dateOfBirth.value),
    cdlNumber: text(answer.cdlNumber.value?.replace(/^(DL|LIC|CDL)\s*(NO\.?|#)?\s*:?\s*/i, '') ?? null, 30),
    issuingState: /^[A-Z]{2}$/.test(state) ? state : null,
    cdlClass: (cls as 'A' | 'B' | 'C' | null) ?? null,
    endorsements: codes(answer.endorsements.value, 8),
    restrictions: codes(answer.restrictions.value, 8),
    cdlIssuedOn: cdlDate(answer.cdlIssuedOn.value),
    cdlExpiresOn: cdlDate(answer.cdlExpiresOn.value),
  };

  // A value the model gave but we could not keep (a date that is not a date) counts as unsure.
  // A middle name, endorsements and restrictions may rightly be absent; only confidence marks them.
  const needsReview = CDL_READ_FIELDS.filter((f) => {
    if (f === 'legalMiddleName' || f === 'endorsements' || f === 'restrictions') return confidence[f] < below;
    return raw[f] === null || confidence[f] < below;
  });

  const extract = CdlExtractSchema.parse({ ...raw, needsReview, source: 'ocr' });
  const warnings: CdlReadWarning[] = [];

  if (!answer.isDriverLicence) {
    warnings.push({ field: 'document', tone: 'urgent', message: 'This does not look like a driver licence - check the file.' });
  } else if (!answer.isCommercial) {
    warnings.push({ field: 'cdlClass', tone: 'warning', message: 'This looks like an ordinary licence, not a commercial one (CDL).' });
  }
  if (extract.cdlExpiresOn && extract.cdlExpiresOn < options.today) {
    warnings.push({ field: 'cdlExpiresOn', tone: 'urgent', message: `The licence expired on ${extract.cdlExpiresOn}.` });
  } else if (extract.cdlExpiresOn && extract.cdlExpiresOn <= plusDays(options.today, 30)) {
    warnings.push({ field: 'cdlExpiresOn', tone: 'warning', message: `The licence expires within 30 days (${extract.cdlExpiresOn}).` });
  }
  if (extract.cdlIssuedOn && extract.cdlExpiresOn && extract.cdlIssuedOn >= extract.cdlExpiresOn) {
    warnings.push({ field: 'cdlIssuedOn', tone: 'warning', message: 'The issue date is not before the expiry date - check both.' });
  }

  const app = options.application;
  if (!app) {
    warnings.push({ field: 'document', tone: 'info', message: 'No DOT application on this case to compare the card with.' });
  } else {
    const typed = (a: string | null, b: string | null) => [a, b].filter(Boolean).join(' ');
    if (app.legalFirstName && extract.legalFirstName && !sameName(app.legalFirstName, extract.legalFirstName)) {
      warnings.push({
        field: 'legalFirstName',
        tone: 'warning',
        message: `First name on the card (${extract.legalFirstName}) differs from the application (${app.legalFirstName}).`,
      });
    }
    if (app.legalLastName && extract.legalLastName && !sameName(app.legalLastName, extract.legalLastName)) {
      warnings.push({
        field: 'legalLastName',
        tone: 'warning',
        message: `Last name on the card (${extract.legalLastName}) differs from the application (${typed(app.legalFirstName, app.legalLastName)}).`,
      });
    }
    if (app.dateOfBirth && extract.dateOfBirth && app.dateOfBirth !== extract.dateOfBirth) {
      warnings.push({
        field: 'dateOfBirth',
        tone: 'warning',
        message: `Date of birth on the card (${extract.dateOfBirth}) differs from the application (${app.dateOfBirth}).`,
      });
    }
    if (extract.cdlNumber && app.licences.length > 0) {
      const match = app.licences.find((l) => sameNumber(l.number, extract.cdlNumber!));
      if (!match) {
        warnings.push({
          field: 'cdlNumber',
          tone: 'warning',
          message: `Licence number ${extract.cdlNumber} is not one the application lists (${app.licences.map((l) => `${l.state} ${l.number}`).join(', ')}).`,
        });
      } else {
        if (extract.issuingState && match.state.toUpperCase() !== extract.issuingState) {
          warnings.push({
            field: 'issuingState',
            tone: 'warning',
            message: `The card is from ${extract.issuingState}; the application says ${match.state.toUpperCase()}.`,
          });
        }
        if (match.expiresOn && extract.cdlExpiresOn && match.expiresOn !== extract.cdlExpiresOn) {
          warnings.push({
            field: 'cdlExpiresOn',
            tone: 'info',
            message: `The application gave the expiry as ${match.expiresOn}; the card says ${extract.cdlExpiresOn}. The card wins once confirmed.`,
          });
        }
      }
    }
  }
  return { extract, confidence, warnings, compared: Boolean(app) };
}
