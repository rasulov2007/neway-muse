import { z } from 'zod';

/**
 * Company info (owner, 2026-10-19): who the carrier is, the papers a broker asks for, and where
 * the trailers sit. One profile per company, edited with a version check; documents are kept by
 * version - a new W-9 replaces the old one on the page, the old one stays on record.
 */

export const COMPANY_DOCUMENT_KINDS = ['w9', 'mc_authority', 'coi', 'noa', 'ein_letter', 'ucr', 'void_check', 'other'] as const;
export type CompanyDocumentKind = (typeof COMPANY_DOCUMENT_KINDS)[number];

export interface CompanyDocumentKindDef {
  kind: CompanyDocumentKind;
  label: string;
  group: 'Registration' | 'Insurance' | 'Factoring' | 'Banking' | 'Other';
  /** Must be on file; a missing one is said on the page. */
  required: boolean;
  /** Carries an expiry date that matters. */
  expires: boolean;
  /** Goes into the broker setup packet. */
  inPacket: boolean;
}

export const COMPANY_DOCUMENT_DEFS: readonly CompanyDocumentKindDef[] = [
  { kind: 'w9', label: 'W-9', group: 'Registration', required: true, expires: false, inPacket: true },
  { kind: 'mc_authority', label: 'MC authority', group: 'Registration', required: true, expires: false, inPacket: true },
  { kind: 'ein_letter', label: 'EIN letter', group: 'Registration', required: false, expires: false, inPacket: false },
  { kind: 'ucr', label: 'UCR', group: 'Registration', required: false, expires: true, inPacket: false },
  { kind: 'coi', label: 'Certificate of insurance', group: 'Insurance', required: true, expires: true, inPacket: true },
  { kind: 'noa', label: 'Notice of assignment', group: 'Factoring', required: true, expires: false, inPacket: true },
  { kind: 'void_check', label: 'Voided check / bank letter', group: 'Banking', required: false, expires: false, inPacket: false },
  { kind: 'other', label: 'Other', group: 'Other', required: false, expires: true, inPacket: false },
];

export const companyDocumentDef = (kind: CompanyDocumentKind): CompanyDocumentKindDef =>
  COMPANY_DOCUMENT_DEFS.find((d) => d.kind === kind) ?? COMPANY_DOCUMENT_DEFS[COMPANY_DOCUMENT_DEFS.length - 1]!;

/** Days before the expiry date a document reads "Expires soon". */
export const COMPANY_DOCUMENT_SOON_DAYS = 30;

export type CompanyDocumentStatus = 'valid' | 'expiring' | 'expired' | 'missing';
export const COMPANY_DOCUMENT_STATUS_LABEL: Record<CompanyDocumentStatus, string> = {
  valid: 'On file',
  expiring: 'Expires soon',
  expired: 'Expired',
  missing: 'Missing',
};

/** Where a document stands today (YYYY-MM-DD, Eastern). */
export function companyDocumentStatus(expiresOn: string | null, today: string): Exclude<CompanyDocumentStatus, 'missing'> {
  if (!expiresOn) return 'valid';
  if (expiresOn < today) return 'expired';
  const soon = new Date(`${today}T00:00:00Z`);
  soon.setUTCDate(soon.getUTCDate() + COMPANY_DOCUMENT_SOON_DAYS);
  return expiresOn <= soon.toISOString().slice(0, 10) ? 'expiring' : 'valid';
}

export interface CompanyDocument {
  id: string;
  kind: CompanyDocumentKind;
  title: string;
  fileId: string;
  fileName: string;
  issuedOn: string | null;
  expiresOn: string | null;
  note: string | null;
  /** 1 for the first file of this kind, then 2, 3 … */
  versionNumber: number;
  uploadedBy: string;
  uploadedAt: string;
  status: Exclude<CompanyDocumentStatus, 'missing'>;
}

export interface TrailerYard {
  id: string;
  name: string;
  address: string;
  note: string;
}

export const TrailerYardSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().trim().min(1, 'Name the yard').max(120),
  address: z.string().trim().max(300).default(''),
  note: z.string().trim().max(300).default(''),
});

const text = (max: number) => z.string().trim().max(max).default('');

export const CompanyProfileFieldsSchema = z.object({
  legalName: text(200),
  dba: text(200),
  mcNumber: text(20),
  dotNumber: text(20),
  ein: text(20),
  scac: text(10),
  phone: text(40),
  email: z.union([z.literal(''), z.string().trim().email('Enter an email address').max(200)]).default(''),
  physicalAddress: text(300),
  mailingAddress: text(300),
  insuranceAgent: text(200),
  insuranceAgentPhone: text(40),
  insuranceAgentEmail: z.union([z.literal(''), z.string().trim().email('Enter an email address').max(200)]).default(''),
  factoringCompany: text(200),
  noaReference: text(120),
  trailerYards: z.array(TrailerYardSchema).max(50).default([]),
  /**
   * Reply-To on the emails NeWay sends for this company (2026-10-27): replies to a recruiting email
   * (the DOT application link, changes requested) and to an accounting email go to the company's
   * own mailbox. Stored on the company itself (companies.recruiting_reply_to / accounting_reply_to);
   * empty = no Reply-To.
   */
  recruitingReplyTo: z.union([z.literal(''), z.string().trim().email('Enter an email address').max(200)]).default(''),
  accountingReplyTo: z.union([z.literal(''), z.string().trim().email('Enter an email address').max(200)]).default(''),
});
export type CompanyProfileFields = z.infer<typeof CompanyProfileFieldsSchema>;

export const UpdateCompanyProfileSchema = CompanyProfileFieldsSchema.partial().extend({ version: z.number().int().min(0) });
export type UpdateCompanyProfileInput = z.infer<typeof UpdateCompanyProfileSchema>;

export const AddCompanyDocumentSchema = z.object({
  kind: z.enum(COMPANY_DOCUMENT_KINDS),
  title: z.string().trim().max(160).optional(),
  fileId: z.string().min(1),
  issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  note: z.string().trim().max(500).nullable().optional(),
});
export type AddCompanyDocumentInput = z.infer<typeof AddCompanyDocumentSchema>;

export const VoidCompanyDocumentSchema = z.object({ reason: z.string().trim().min(3, 'Say why').max(500) });

/** One row per kind on the page: the current file, or the gap. */
export interface CompanyDocumentSlot {
  kind: CompanyDocumentKind;
  label: string;
  group: CompanyDocumentKindDef['group'];
  required: boolean;
  inPacket: boolean;
  status: CompanyDocumentStatus;
  current: CompanyDocument | null;
  /** Earlier versions, newest first. */
  history: CompanyDocument[];
}

export interface CompanyProfileView {
  profile: CompanyProfileFields;
  version: number;
  updatedAt: string | null;
  updatedBy: string | null;
  today: string;
  /** Every kind except "other", plus each "other" file on its own row. */
  documents: CompanyDocumentSlot[];
  /** The broker setup packet: ready, or what keeps it from being sent. */
  packet: { ready: boolean; problems: string[]; kinds: CompanyDocumentKind[] };
  canEdit: boolean;
}

/** What keeps the broker packet from going out: a packet paper missing or expired. */
export function brokerPacketProblems(slots: readonly CompanyDocumentSlot[]): string[] {
  const out: string[] = [];
  for (const s of slots.filter((x) => x.inPacket)) {
    if (s.status === 'missing') out.push(`${s.label} is not on file.`);
    else if (s.status === 'expired') out.push(`${s.label} expired ${s.current?.expiresOn ?? ''}.`.trim());
  }
  return out;
}
