import {
  DotApplicationDraftFormSchema,
  type AccidentEntry,
  type AddressEntry,
  type ConvictionEntry,
  type DotApplicationDraftForm,
  type DotSectionState,
  type EmploymentEntry,
  type LicenseEntry,
} from '@neway/shared';

/**
 * The DOT application's draft as the form holds it, shared by the recruiter's wizard and the
 * driver's page (/dot/<token>): blank entries, the opening draft, and the shape saved to the API.
 */

export type Draft = DotApplicationDraftForm & { ssn: string };

export const EMPTY_ADDRESS: AddressEntry = { street: '', city: '', state: '', zip: '', from: '', to: null };
export const EMPTY_LICENSE: LicenseEntry = { state: '', number: '', licenseClass: 'A', endorsements: [], expiresOn: '' };
export const EMPTY_EMPLOYER: EmploymentEntry = {
  kind: 'employer',
  employer: '',
  address: null,
  phone: null,
  contactName: null,
  position: '',
  from: '',
  to: null,
  reasonForLeaving: null,
  droveCmv: true,
  dotRegulated: true,
  subjectToDrugTesting: true,
};
export const EMPTY_GAP: EmploymentEntry = { kind: 'gap', from: '', to: null, explanation: '' };
export const EMPTY_ACCIDENT: AccidentEntry = { date: '', location: '', nature: '', fatalities: 0, injuries: 0, hazmatSpill: false };
export const EMPTY_CONVICTION: ConvictionEntry = { date: '', location: '', offense: '', penalty: null };

/** The draft the form opens with: what was saved, or a blank application in the person's name. */
export function initialDraft(name: { firstName: string; lastName: string }, form: DotApplicationDraftForm | null): Draft {
  if (form) return { ...DotApplicationDraftFormSchema.parse(form), ssn: '' };
  return {
    legalFirstName: name.firstName,
    legalMiddleName: null,
    legalLastName: name.lastName,
    dateOfBirth: '',
    ssn: '',
    addresses: [{ ...EMPTY_ADDRESS }],
    licenses: [{ ...EMPTY_LICENSE }],
    employment: [{ ...EMPTY_EMPLOYER }],
    accidents: [],
    convictions: [],
    licenseDeniedOrRevoked: false,
    licenseDeniedOrRevokedDetail: null,
    certifiedName: null,
    certifiedOn: null,
  };
}

const nul = (v: string | null | undefined) => (v && v.trim() ? v.trim() : null);

/** The form as the draft contract takes it: optional text and open-ended dates become null. */
export function toForm(draft: Draft): DotApplicationDraftForm {
  const { ssn: _ssn, ...form } = draft;
  void _ssn;
  return {
    ...form,
    legalMiddleName: nul(form.legalMiddleName),
    addresses: form.addresses.map((a) => ({ ...a, to: nul(a.to) })),
    employment: form.employment.map((e) =>
      e.kind === 'gap'
        ? { ...e, to: nul(e.to) }
        : { ...e, address: nul(e.address), phone: nul(e.phone), contactName: nul(e.contactName), reasonForLeaving: nul(e.reasonForLeaving), to: nul(e.to) },
    ),
    convictions: form.convictions.map((c) => ({ ...c, penalty: nul(c.penalty) })),
    licenseDeniedOrRevokedDetail: nul(form.licenseDeniedOrRevokedDetail),
    certifiedName: nul(form.certifiedName),
    certifiedOn: nul(form.certifiedOn),
  };
}

export const STATE_LABEL: Record<DotSectionState, string> = { not_started: 'Not started', in_progress: 'In progress', complete: 'Complete' };
