import type { DotAppAnswers, DotAppLicense, DotAppStepId } from '@neway/shared';

export interface StepMeta {
  eyebrow: string;
  sub: string;
}
// Driver-facing wording (the prototype's driver build replaces the internal "Source:" lines).
export const STEP_META: Readonly<Record<DotAppStepId, StepMeta>> = {
  personal: { eyebrow: 'Let’s get to know you', sub: 'Your name, address and contact details.' },
  company: { eyebrow: 'Position & eligibility', sub: 'The position you are applying for and a few general questions.' },
  license: { eyebrow: 'Your CDL & experience', sub: 'Your driving experience and every license you hold.' },
  employment: { eyebrow: 'Work history', sub: 'List your most recent employer first. Include periods without work.' },
  history: { eyebrow: 'FMCSR, accidents & violations', sub: 'Answer every question honestly. A "Yes" does not automatically disqualify you.' },
  emergency: { eyebrow: 'Emergency contact information', sub: 'Who we should contact in an emergency.' },
  certs: { eyebrow: 'Federal driver certifications', sub: 'Four separate federal forms. Each is signed on its own.' },
  disclosures: { eyebrow: 'Background check disclosures', sub: 'Each disclosure is a separate document with its own acknowledgement. Consents you already signed are linked, not repeated.' },
  policies: { eyebrow: 'Company acknowledgements', sub: 'Company documents you must read and acknowledge before driving.' },
  contractor: { eyebrow: 'Owner-operator & contractor forms', sub: 'Shown because you applied as an owner-operator or contractor.' },
  documents: { eyebrow: 'Upload your documents', sub: 'Take a photo or choose a file. JPG, PNG, HEIC or PDF, up to 15 MB each.' },
  review: { eyebrow: 'Review & send', sub: 'Check your answers. You can go back to any section.' },
};

export const currentLicense = (a: DotAppAnswers): DotAppLicense => (a.licenses ?? []).find((l) => l.current === 'Yes') ?? (a.licenses ?? [])[0] ?? {};
export const fullName = (a: DotAppAnswers, middleInitial = false) =>
  [a.personal?.firstName, middleInitial ? a.personal?.middleName?.[0] : a.personal?.middleName, a.personal?.lastName].filter(Boolean).join(' ');
