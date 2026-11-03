import { createHash } from 'node:crypto';
import type { ConsentDocumentType } from '@neway/shared';
import { DRIVER_DISCLOSURES, DRIVER_DISCLOSURE_VERSION } from './driver-disclosures';

/**
 * The disclosures the candidate consent shows and signs (owner brief, 2026-10-11).
 *
 * MVR and PSP are the same official texts the approved application page carries, byte for byte
 * (`driver-disclosures.ts`, version `source-snapshot-2026-10-08`): nothing is rewritten, shortened
 * or combined, and the PSP disclosure stays its own standalone document.
 *
 * Clearinghouse: FMCSA's "Sample Format: General Consent for Limited Queries of the FMCSA Drug and
 * Alcohol Clearinghouse" (clearinghouse.fmcsa.dot.gov/Resource/Index/Sample-Limited-Consent-Form,
 * PDF created 2019-08-16, sha256 d48d987b…, retrieved 2026-10-11). Its three paragraphs are kept
 * word for word. Two things are filled in, as the sample directs: (Company Name) — the employer's
 * registered name (setting `hiring.clearinghouse_employer_name`, "NORTHWIND FREIGHT INC.") — and
 * (Driver Name) — the name the driver signs with. The sample's bracketed editor's note is not shown
 * to the driver; in its place stands the scope the company chose (owner, 2026-10-11): one limited
 * query, within 30 days of signing. That scope is the company's choice, not an FMCSA time limit.
 *
 * Each signed document keeps the exact text the driver saw (name and employer filled in), its
 * version and its hash, so a later change here never alters what was signed.
 */
export const CONSENT_DISCLOSURE_VERSION = DRIVER_DISCLOSURE_VERSION;

export const CONSENT_DISCLOSURE_TITLES: Readonly<Record<ConsentDocumentType, string>> = {
  mvr: 'Motor Vehicle Record (MVR) disclosure and authorization',
  psp: 'Pre-Employment Screening Program (PSP) disclosure and authorization',
  clearinghouse: 'FMCSA Drug and Alcohol Clearinghouse — limited query consent',
};

export const CLEARINGHOUSE_SOURCE = {
  url: 'https://clearinghouse.fmcsa.dot.gov/Resource/Index/Sample-Limited-Consent-Form',
  pdfSha256: 'd48d987be208922cd799d40735ae8aaad4ce0cf6b019a4cfca85ca313c4a16bd',
  retrievedOn: '2026-10-11',
} as const;

/** The company's chosen scope (owner, 2026-10-11): one limited query, within 30 days of signing. */
export const CLEARINGHOUSE_SCOPE = { queries: 1, validDays: 30 } as const;

export const CLEARINGHOUSE_VERSION = 'fmcsa-sample-2019-08-16+single-query-30d-v1';

/** Placeholders exactly as the FMCSA sample writes them. */
export const DRIVER_NAME = '(Driver Name)';
export const COMPANY_NAME = '(Company Name)';

/** The sample's first paragraph, up to where its bracketed editor's note begins. */
const CH_P1 =
  'I, (Driver Name), hereby provide consent to (Company Name) to conduct a limited query of the FMCSA Commercial Driver’s License Drug and Alcohol Clearinghouse (Clearinghouse) to determine whether drug or alcohol violation information about me exists in the Clearinghouse.';
/** The scope, in the place of the sample's note "[Employers and employees may also wish to include the terms of the consent …]". */
const CH_SCOPE =
  'This consent is for one (1) limited query, which (Company Name) may conduct within 30 days of the date I sign this consent.';
const CH_P2 =
  'I understand that if the limited query conducted by (Company Name) indicates that drug or alcohol violation information about me exists in the Clearinghouse, FMCSA will not disclose that information to (Company Name) without first obtaining additional specific consent from me.';
const CH_P3 =
  'I further understand that if I refuse to provide consent for (Company Name) to conduct a limited query of the Clearinghouse, (Company Name) must prohibit me from performing safety-sensitive functions, including driving a commercial motor vehicle, as required by FMCSA’s drug and alcohol program regulations.';

/** The FMCSA sentences as published (for the verbatim check against the source PDF). */
export const CLEARINGHOUSE_OFFICIAL_SENTENCES = [CH_P1, CH_P2, CH_P3] as const;

const CLEARINGHOUSE_TEMPLATE = `${CH_P1} ${CH_SCOPE}\n\n${CH_P2}\n\n${CH_P3}`;

/** Current text and version of each disclosure; a type with no text is not offered. */
const CURRENT: Readonly<Record<ConsentDocumentType, { version: string; text: string } | null>> = {
  mvr: { version: CONSENT_DISCLOSURE_VERSION, text: DRIVER_DISCLOSURES.mvr },
  psp: { version: CONSENT_DISCLOSURE_VERSION, text: DRIVER_DISCLOSURES.psp },
  clearinghouse: { version: CLEARINGHOUSE_VERSION, text: CLEARINGHOUSE_TEMPLATE },
};

export const sha256Text = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

const fill = (text: string, placeholder: string, value: string) => text.split(placeholder).join(value);

export interface PublishedDisclosure {
  type: ConsentDocumentType;
  /** As the page shows it: the employer filled in; (Driver Name) left for the name the driver types. */
  text: string;
  version: string;
  /** Hash of the published template, which the page acknowledges when it signs. */
  sha256: string;
  /** Present when the text carries the driver's name: the page fills it live as they type. */
  driverNamePlaceholder: string | null;
  scope: string | null;
}

/** The disclosures a driver signs today, in order, and the ones still waiting for wording. */
export function currentDisclosures(employerName = COMPANY_NAME): { published: PublishedDisclosure[]; pending: ConsentDocumentType[] } {
  const order: ConsentDocumentType[] = ['mvr', 'psp', 'clearinghouse'];
  const published = order.flatMap((type): PublishedDisclosure[] => {
    const current = CURRENT[type];
    if (!current) return [];
    const isCh = type === 'clearinghouse';
    return [
      {
        type,
        text: isCh ? fill(current.text, COMPANY_NAME, employerName) : current.text,
        version: current.version,
        sha256: sha256Text(current.text),
        driverNamePlaceholder: isCh ? DRIVER_NAME : null,
        scope: isCh ? `One limited query within ${CLEARINGHOUSE_SCOPE.validDays} days of signing (company scope)` : null,
      },
    ];
  });
  return { published, pending: order.filter((type) => !CURRENT[type]) };
}

/** The exact text a driver signed: the template with the employer and the signer's name filled in. */
export function signedText(type: ConsentDocumentType, employerName: string, driverName: string): string {
  const current = CURRENT[type];
  if (!current) throw new Error(`${type} is not published`);
  return type === 'clearinghouse' ? fill(fill(current.text, COMPANY_NAME, employerName), DRIVER_NAME, driverName) : current.text;
}

/** Until when a signed Clearinghouse limited consent may be used (company scope); null for the others. */
export function validUntil(type: ConsentDocumentType, signedAt: Date): Date | null {
  return type === 'clearinghouse' ? new Date(signedAt.getTime() + CLEARINGHOUSE_SCOPE.validDays * 86_400_000) : null;
}
