import type { DotAppAnswers, DotAppEmployer } from './answers.js';
import { isDotAppContractor, isDotAppOwner } from './answers.js';
import {
  DOT_APP_DOCUMENTS,
  DOT_APP_STEP_IDS,
  DOT_APP_STEP_TITLES,
  evSignatureKey,
  fcraAuthorizationKey,
  fcraDisclosureKey,
  signatureDocKey,
  sphSignatureKey,
  type DotAppConsentLink,
  type DotAppStepId,
  type DotAppUploadSlot,
} from './documents.js';

/**
 * What is still needed before Submit — one rule for the phone ("Still needed" with Fix links) and
 * for the server (Submit is refused while anything is listed). Pure: the caller passes what is on
 * file (signatures, uploads, the company's approved documents, the Consent Form links, today).
 */

export interface DotAppContext {
  /** Today in the company's business zone (US Eastern), YYYY-MM-DD, from the server clock. */
  today: string;
  /** Current (not superseded) driver signature keys. */
  signatures: ReadonlySet<string>;
  /** Upload slots with a current file. */
  uploads: ReadonlySet<string>;
  /** Document keys with an approved template for the candidate's company. */
  approvedDocs: ReadonlySet<string>;
  /** Consent Form documents on file for this candidate (signed, reviewed). */
  consentLinks: ReadonlySet<DotAppConsentLink>;
  /** An SSN is sealed on the application. */
  ssnOnFile: boolean;
  /** ACH debit routing + account numbers are sealed on the application. */
  bankOnFile?: boolean;
  /**
   * The approved template content of a document, when the caller has it. The initials and items
   * the page draws come from the company's own document (its pages and items), so what is required
   * follows the same document; without it the Harbor Line layout is assumed (2 initialled pages, 3 video
   * initials, 12 receipt items).
   */
  templateContent?: (docKey: string) => Record<string, unknown> | undefined;
}

/** IC acknowledgement pages the driver initials (the page draws a box for each `initials: true` page). */
export function dotAppIcaInitialPages(content: Record<string, unknown> | undefined): number[] {
  const pages = content?.pages;
  if (!Array.isArray(pages)) return [0, 1];
  return pages.flatMap((p, i) => (p && typeof p === 'object' && (p as { initials?: unknown }).initials ? [i] : []));
}

/** How many entries of a document's `items` the page shows (capped), or the fallback without content. */
export function dotAppItemCount(content: Record<string, unknown> | undefined, fallback: number, cap = fallback): number {
  const items = content?.items;
  return Array.isArray(items) ? Math.min(items.length, cap) : fallback;
}

export interface DotAppMissingItem {
  step: DotAppStepId;
  /** The answer path, upload slot or signature key it is about. */
  key: string;
  label: string;
  kind: 'field' | 'signature' | 'upload' | 'document';
}

const filled = (v: unknown): boolean =>
  v !== undefined && v !== null && !(typeof v === 'string' && v.trim() === '') && !(Array.isArray(v) && v.length === 0) && v !== false;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const digits = (v: string | undefined) => (v ?? '').replace(/\D/g, '');
export const dotAppChecks = {
  phone: (v: string | undefined) => digits(v).length >= 10,
  email: (v: string | undefined) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test((v ?? '').trim()),
  vin: (v: string | undefined) => (v ?? '').trim().length === 17,
  date: (v: string | undefined) => DATE.test(v ?? ''),
};

export function dotAppVisibleSteps(a: DotAppAnswers): DotAppStepId[] {
  return DOT_APP_STEP_IDS.filter((s) => s !== 'contractor' || isDotAppContractor(a));
}

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Employment coverage over the last 3 years: employers + unemployment + schools, gaps over 31 days. */
export function dotAppCoverage(a: DotAppAnswers, today: string): { months: number; gaps: [string, string | null][]; ok: boolean } {
  const start = addDays(today, -365 * 3);
  const day = 86_400_000;
  const t = (iso: string) => Date.parse(`${iso}T12:00:00Z`);
  const spans = [...(a.employers ?? []), ...(a.unemployment ?? []), ...(a.schools ?? [])]
    .filter((x) => x.start && DATE.test(x.start))
    .map((x) => [t(x.start as string), x.end && DATE.test(x.end) ? t(x.end) : t(today)] as [number, number])
    .sort((x, y) => x[0] - y[0]);
  let cur = t(start);
  const end = t(today);
  const gaps: [string, string | null][] = [];
  let covered = 0;
  for (const [s, e] of spans) {
    if (s > cur && s - cur > 31 * day) gaps.push([new Date(cur).toISOString().slice(0, 10), new Date(s).toISOString().slice(0, 10)]);
    if (e > cur) {
      covered += e - Math.max(cur, s);
      cur = e;
    }
  }
  if (end - cur > 31 * day) gaps.push([new Date(cur).toISOString().slice(0, 10), null]);
  const months = Math.min(36, Math.round(covered / (30.44 * day)));
  return { months, gaps, ok: months >= 35 && gaps.length === 0 };
}

/** Previous employers of the last 3 years where the driver did DOT drug-and-alcohol-tested work. */
export function dotAppSphEmployers(a: DotAppAnswers, today: string): (DotAppEmployer & { id: string })[] {
  const cutoff = addDays(today, -365 * 3);
  return (a.employers ?? [])
    .filter((e): e is DotAppEmployer & { id: string } => Boolean(e.id && e.company?.trim()))
    .filter((e) => e.dotTesting === 'Yes' && (!e.end || e.end >= cutoff));
}

/**
 * The previous employers of the last 3 years (any employer listed, DOT-tested or not): one 391.23
 * Request/Consent each, with the employer's name in the box after "hereby authorize".
 */
export function dotAppEvEmployers(a: DotAppAnswers, today: string): (DotAppEmployer & { id: string })[] {
  const cutoff = addDays(today, -365 * 3);
  return (a.employers ?? [])
    .filter((e): e is DotAppEmployer & { id: string } => Boolean(e.id && e.company?.trim()))
    .filter((e) => !e.end || e.end >= cutoff);
}

export interface DotAppFcraEntity {
  id: string;
  kind: 'employer' | 'school';
  name: string;
}
/**
 * Every employer and trucking school in Employment history: one FCRA Disclosure + Authorization
 * pair each ("Employer / Contractor / Educational Institution:"), WB-app pp.26–29.
 */
export function dotAppFcraEntities(a: DotAppAnswers): DotAppFcraEntity[] {
  const out: DotAppFcraEntity[] = [];
  for (const e of a.employers ?? []) if (e.id && e.company?.trim()) out.push({ id: e.id, kind: 'employer', name: e.company.trim() });
  for (const s of a.schools ?? []) if (s.id && s.school?.trim()) out.push({ id: s.id, kind: 'school', name: s.school.trim() });
  return out;
}

const PER_ENTITY = new Set(['sph_request', 'emp_verification', 'fcra_disclosure_entity', 'fcra_authorization_entity']);

/** The upload slots this application asks for, required first. */
export function dotAppUploadSlots(a: DotAppAnswers): { slot: DotAppUploadSlot; required: boolean }[] {
  const list: { slot: DotAppUploadSlot; required: boolean }[] = [
    { slot: 'cdl_front', required: true },
    { slot: 'cdl_back', required: true },
    { slot: 'med_card', required: true },
  ];
  if (a.company?.twic === 'Yes') list.push({ slot: 'twic', required: true });
  if (isDotAppOwner(a)) list.push({ slot: 'registration', required: false });
  list.push({ slot: 'other', required: false });
  return list;
}

/** The driver signatures a step needs, given the company's approved documents and the consent links. */
export function dotAppSignaturesFor(step: DotAppStepId, a: DotAppAnswers, ctx: Pick<DotAppContext, 'approvedDocs' | 'consentLinks' | 'today'>): string[] {
  const keys = DOT_APP_DOCUMENTS.filter(
    (d) => d.step === step && d.signer === 'driver' && !PER_ENTITY.has(d.key) && !(d.consentLink && ctx.consentLinks.has(d.consentLink)),
  ).map((d) => d.key);
  if (step === 'disclosures') {
    // 391.23 Request/Consent: one per previous employer of the last 3 years (the generic one when none).
    const ev = dotAppEvEmployers(a, ctx.today);
    const at = keys.indexOf('clearinghouse_ongoing');
    const evKeys = ev.length ? ev.map((e) => evSignatureKey(e.id)) : ['emp_verification'];
    keys.splice(at < 0 ? keys.length : at, 0, ...evKeys);
    for (const x of dotAppFcraEntities(a)) {
      if (ctx.approvedDocs.has('fcra_disclosure_entity')) keys.push(fcraDisclosureKey(x.id));
      if (ctx.approvedDocs.has('fcra_authorization_entity')) keys.push(fcraAuthorizationKey(x.id));
    }
    if (ctx.approvedDocs.has('sph_request')) for (const e of dotAppSphEmployers(a, ctx.today)) keys.push(sphSignatureKey(e.id));
  }
  return keys;
}

export function dotAppMissing(a: DotAppAnswers, ctx: DotAppContext): DotAppMissingItem[] {
  const out: DotAppMissingItem[] = [];
  const need = (step: DotAppStepId, key: string, label: string, value: unknown) => {
    if (!filled(value)) out.push({ step, key, label, kind: 'field' });
  };
  const check = (step: DotAppStepId, key: string, label: string, value: string | undefined, ok: (v: string | undefined) => boolean) => {
    if (filled(value) && !ok(value)) out.push({ step, key, label, kind: 'field' });
  };
  const yn = (step: DotAppStepId, key: string, label: string, value: unknown) => need(step, key, label, value);
  const p = a.personal ?? {};

  // 1 Personal information
  need('personal', 'personal.firstName', 'First name', p.firstName);
  need('personal', 'personal.lastName', 'Last name', p.lastName);
  need('personal', 'personal.address.street', 'Street address', p.address?.street);
  need('personal', 'personal.address.city', 'City', p.address?.city);
  need('personal', 'personal.address.state', 'State/Province', p.address?.state);
  need('personal', 'personal.address.zip', 'Zip/Postal', p.address?.zip);
  need('personal', 'personal.address.country', 'Country', p.address?.country);
  yn('personal', 'personal.res3', 'Residence 3 years or longer', p.res3);
  if (p.res3 === 'No') {
    const prev = p.prevAddresses ?? [];
    if (prev.length === 0) out.push({ step: 'personal', key: 'personal.prevAddresses', label: 'Previous addresses', kind: 'field' });
    prev.forEach((x, i) => {
      const n = `Previous address ${i + 1}`;
      need('personal', `personal.prevAddresses.${i}.street`, `${n}: street`, x.street);
      need('personal', `personal.prevAddresses.${i}.city`, `${n}: city`, x.city);
      need('personal', `personal.prevAddresses.${i}.state`, `${n}: state`, x.state);
      need('personal', `personal.prevAddresses.${i}.zip`, `${n}: zip`, x.zip);
      need('personal', `personal.prevAddresses.${i}.country`, `${n}: country`, x.country);
      need('personal', `personal.prevAddresses.${i}.from`, `${n}: from`, x.from);
      need('personal', `personal.prevAddresses.${i}.to`, `${n}: to`, x.to);
    });
  }
  if (!ctx.ssnOnFile) out.push({ step: 'personal', key: 'personal.ssn', label: 'SSN/SIN', kind: 'field' });
  need('personal', 'personal.dob', 'Date of Birth', p.dob);
  need('personal', 'personal.phone', 'Primary Phone', p.phone);
  check('personal', 'personal.phone', 'Primary Phone (10 digits)', p.phone, dotAppChecks.phone);
  need('personal', 'personal.email', 'Email', p.email);
  check('personal', 'personal.email', 'Email (valid address)', p.email, dotAppChecks.email);

  // 2 Company questions
  const c = a.company ?? {};
  need('company', 'company.position', 'What position are you applying for?', c.position);
  need('company', 'company.location', 'What location are you applying for?', c.location);
  yn('company', 'company.isOwner', 'If you answered "Owner Operator" or "Fleet Owner", select yes.', c.isOwner);
  if (c.isOwner === 'Yes') {
    const eq = c.equipment ?? [];
    if (eq.length === 0) out.push({ step: 'company', key: 'company.equipment', label: 'Equipment Description (Tractor)', kind: 'field' });
    eq.forEach((t, i) => {
      const n = `Tractor ${i + 1}`;
      need('company', `company.equipment.${i}.type`, `${n}: Type`, t.type);
      need('company', `company.equipment.${i}.year`, `${n}: Year`, t.year);
      need('company', `company.equipment.${i}.make`, `${n}: Make`, t.make);
      need('company', `company.equipment.${i}.model`, `${n}: Model`, t.model);
      need('company', `company.equipment.${i}.vin`, `${n}: VIN`, t.vin);
      check('company', `company.equipment.${i}.vin`, `${n}: VIN (17 characters)`, t.vin, dotAppChecks.vin);
    });
  }
  yn('company', 'company.eligible', 'Are you legally eligible for employment in the United States?', c.eligible);
  yn('company', 'company.employed', 'Are you currently employed?', c.employed);
  if (c.employed === 'No') need('company', 'company.lastEnd', 'What date did your last employment end?', c.lastEnd);
  yn('company', 'company.english', 'Do you read, write, and speak English?', c.english);
  yn('company', 'company.workedBefore', 'Have you ever worked for this company before?', c.workedBefore);
  if (c.workedBefore === 'Yes') need('company', 'company.workedBeforeDetails', 'Enter start and end dates, location, position, and reason for leaving', c.workedBeforeDetails);
  yn('company', 'company.twic', 'Do you have a current TWIC card?', c.twic);
  if (c.twic === 'Yes') need('company', 'company.twicExp', 'TWIC expiration date', c.twicExp);
  yn('company', 'company.otherName', 'Have you ever been known by any other name?', c.otherName);
  if (c.otherName === 'Yes') need('company', 'company.otherNameText', 'Other name', c.otherNameText);
  need('company', 'company.heard', 'How did you hear about us?', c.heard);
  if (c.heard === 'Driver Referral') need('company', 'company.referral', "Referring driver's name", c.referral);
  if (c.heard === 'Other') need('company', 'company.heardOther', 'If "Other", please explain', c.heardOther);

  // 3 License & experience
  const ex = a.exp ?? {};
  need('license', 'exp.straight', 'Experience: Straight Truck', ex.straight);
  need('license', 'exp.tractorSemi', 'Experience: Tractor and Semi-Trailer', ex.tractorSemi);
  need('license', 'exp.twoTrailers', 'Experience: Tractor - Two Trailers', ex.twoTrailers);
  need('license', 'exp.other', 'Experience: Other', ex.other);
  const lic = a.licenses ?? [];
  if (lic.length === 0) out.push({ step: 'license', key: 'licenses', label: 'At least one license', kind: 'field' });
  lic.forEach((l, i) => {
    const n = `License ${i + 1}`;
    need('license', `licenses.${i}.number`, `${n}: License Number`, l.number);
    need('license', `licenses.${i}.authority`, `${n}: Licensing Authority`, l.authority);
    need('license', `licenses.${i}.country`, `${n}: Country`, l.country);
    need('license', `licenses.${i}.cls`, `${n}: License Class`, l.cls);
    need('license', `licenses.${i}.exp`, `${n}: License Expiration Date`, l.exp);
    if (i === 0) need('license', `licenses.${i}.med`, `${n}: DOT Medical Card Expiration Date`, l.med);
    yn('license', `licenses.${i}.current`, `${n}: Current License`, l.current);
    yn('license', `licenses.${i}.cdl`, `${n}: Commercial Driver License`, l.cdl);
  });

  // 4 Employment history
  const emps = a.employers ?? [];
  if (emps.length === 0) out.push({ step: 'employment', key: 'employers', label: 'At least one employer', kind: 'field' });
  emps.forEach((e, i) => {
    const n = e.company?.trim() || `Employer ${i + 1}`;
    const cur = e.current === 'Yes';
    need('employment', `employers.${i}.company`, `Employer ${i + 1}: Company`, e.company);
    need('employment', `employers.${i}.start`, `${n}: Start Date`, e.start);
    if (!cur) need('employment', `employers.${i}.end`, `${n}: End Date`, e.end);
    need('employment', `employers.${i}.address.street`, `${n}: Street address`, e.address?.street);
    need('employment', `employers.${i}.address.city`, `${n}: City`, e.address?.city);
    need('employment', `employers.${i}.address.state`, `${n}: State/Province`, e.address?.state);
    need('employment', `employers.${i}.address.zip`, `${n}: Zip/Postal`, e.address?.zip);
    need('employment', `employers.${i}.address.country`, `${n}: Country`, e.address?.country);
    need('employment', `employers.${i}.phone`, `${n}: Phone`, e.phone);
    need('employment', `employers.${i}.position`, `${n}: Position Held`, e.position);
    if (!cur) need('employment', `employers.${i}.reason`, `${n}: Reason for leaving?`, e.reason);
    for (const [k, l] of [
      ['terminated', 'Were you terminated/discharged/laid off?'],
      ['current', 'Is this your current employer?'],
      ['contact', 'May we contact this employer at this time?'],
      ['cmv', 'Did you operate a commercial motor vehicle?'],
      ['fmcsr', 'Were you subject to the FMCSA or Transport Canada Safety Regulations?'],
      ['dotTesting', 'Did you perform DOT-tested safety sensitive functions?'],
    ] as const)
      yn('employment', `employers.${i}.${k}`, `${n}: ${l}`, e[k]);
    if (e.cmv === 'Yes') {
      need('employment', `employers.${i}.areas`, `${n}: Areas Driven`, e.areas);
      need('employment', `employers.${i}.miles`, `${n}: Miles driven weekly`, e.miles);
      need('employment', `employers.${i}.truck`, `${n}: Most common truck driven`, e.truck);
      need('employment', `employers.${i}.trailer`, `${n}: Most common trailer`, e.trailer);
      need('employment', `employers.${i}.trailerLen`, `${n}: Trailer length`, e.trailerLen);
    }
  });
  (a.unemployment ?? []).forEach((u, i) => {
    need('employment', `unemployment.${i}.start`, `Unemployment ${i + 1}: Start Date`, u.start);
    need('employment', `unemployment.${i}.end`, `Unemployment ${i + 1}: End Date`, u.end);
  });
  (a.schools ?? []).forEach((s, i) => {
    need('employment', `schools.${i}.start`, `Trucking school ${i + 1}: Start Date`, s.start);
    need('employment', `schools.${i}.end`, `Trucking school ${i + 1}: End Date`, s.end);
    need('employment', `schools.${i}.school`, `Trucking school ${i + 1}: School`, s.school);
    yn('employment', `schools.${i}.graduated`, `Trucking school ${i + 1}: Did you graduate?`, s.graduated);
    yn('employment', `schools.${i}.fmcsr`, `Trucking school ${i + 1}: subject to the Safety Regulations?`, s.fmcsr);
    yn('employment', `schools.${i}.dotTesting`, `Trucking school ${i + 1}: DOT-tested safety sensitive functions?`, s.dotTesting);
  });

  // 5 Safety record
  const f = a.fmcsr ?? {};
  yn('history', 'fmcsr.disqualified', 'Currently disqualified (FMCSR 391.15)?', f.disqualified);
  yn('history', 'fmcsr.suspended', 'License ever suspended or revoked?', f.suspended);
  yn('history', 'fmcsr.denied', 'Ever denied a license, permit, or privilege?', f.denied);
  yn('history', 'fmcsr.preEmpPositive', 'Pre-employment positive test or refusal (past two years)?', f.preEmpPositive);
  yn('history', 'fmcsr.convicted', 'Convicted of a listed offense (past three years)?', f.convicted);
  yn('history', 'accidents.any', 'Accidents/incidents in the last 5 years', a.accidents?.any);
  if (a.accidents?.any === 'Yes') {
    const list = a.accidents.list ?? [];
    if (list.length === 0) out.push({ step: 'history', key: 'accidents.list', label: 'Accident details', kind: 'field' });
    list.forEach((x, i) => {
      const n = `Accident ${i + 1}`;
      need('history', `accidents.list.${i}.date`, `${n}: Date`, x.date);
      need('history', `accidents.list.${i}.location`, `${n}: Location (City, State)`, x.location);
      need('history', `accidents.list.${i}.injuries`, `${n}: No. of Injuries`, x.injuries);
      need('history', `accidents.list.${i}.fatalities`, `${n}: No. of Fatalities`, x.fatalities);
      yn('history', `accidents.list.${i}.hazmat`, `${n}: Hazmat Spill`, x.hazmat);
      yn('history', `accidents.list.${i}.cmv`, `${n}: In Commercial Vehicle`, x.cmv);
    });
  }
  yn('history', 'violations.any', 'Moving violations or traffic convictions in the past 3 years', a.violations?.any);
  if (a.violations?.any === 'Yes') {
    const list = a.violations.list ?? [];
    if (list.length === 0) out.push({ step: 'history', key: 'violations.list', label: 'Violation details', kind: 'field' });
    list.forEach((x, i) => {
      const n = `Violation ${i + 1}`;
      need('history', `violations.list.${i}.date`, `${n}: Violation Date`, x.date);
      need('history', `violations.list.${i}.state`, `${n}: Violation State/Province`, x.state);
      need('history', `violations.list.${i}.charge`, `${n}: Charge / Description`, x.charge);
      for (const [k, l] of [
        ['cmv', 'In Commercial Vehicle'],
        ['fined', 'Fined?'],
        ['suspended', 'License Suspended?'],
        ['revoked', 'License Revoked?'],
        ['community', 'Perform Community Service?'],
        ['otherPenalty', 'Other Penalty?'],
      ] as const)
        yn('history', `violations.list.${i}.${k}`, `${n}: ${l}`, x[k]);
    });
  }
  const cr = a.criminal ?? {};
  yn('history', 'criminal.convicted', 'Have you ever been convicted of a crime?', cr.convicted);
  yn('history', 'criminal.deferred', 'Do you have any deferred prosecutions?', cr.deferred);
  yn('history', 'criminal.pending', 'Do you have criminal charges pending?', cr.pending);
  yn('history', 'criminal.felony', 'Felony plea or conviction?', cr.felony);
  // Asked of every driver, as the source form does (not only after a felony "Yes").
  yn('history', 'criminal.canadaPermit', "Minister's permit to enter or exit Canada?", cr.canadaPermit);
  yn('history', 'criminal.misdemeanor', 'Misdemeanor in the last five years?', cr.misdemeanor);

  // 6 Emergency contact
  const em = a.emergency ?? {};
  need('emergency', 'emergency.c1.name', 'Emergency Contact #1: Name', em.c1?.name);
  need('emergency', 'emergency.c1.relationship', 'Emergency Contact #1: Relationship', em.c1?.relationship);
  need('emergency', 'emergency.c1.address', 'Emergency Contact #1: Address', em.c1?.address);
  need('emergency', 'emergency.c1.csz', 'Emergency Contact #1: City, State, Zip', em.c1?.csz);
  need('emergency', 'emergency.c1.phone', 'Emergency Contact #1: Phone Number', em.c1?.phone);
  check('emergency', 'emergency.c1.phone', 'Emergency Contact #1: Phone (10 digits)', em.c1?.phone, dotAppChecks.phone);

  // 7 Driver certifications
  if (!a.cov?.none) {
    const list = a.cov?.list ?? [];
    if (list.length === 0) out.push({ step: 'certs', key: 'cov.none', label: 'Certification of Violations: list violations or tick None', kind: 'field' });
    list.forEach((x, i) => {
      const n = `Violation (past 12 months) ${i + 1}`;
      need('certs', `cov.list.${i}.date`, `${n}: Date`, x.date);
      need('certs', `cov.list.${i}.offense`, `${n}: Offense`, x.offense);
      need('certs', `cov.list.${i}.location`, `${n}: Location`, x.location);
      need('certs', `cov.list.${i}.vehicle`, `${n}: Type of Vehicle Operated`, x.vehicle);
    });
  }
  yn('certs', 'prevda.q1', 'Previous Employment A&D: question 1', a.prevda?.q1);
  if (a.prevda?.q1 === 'Yes') yn('certs', 'prevda.q2', 'Previous Employment A&D: question 2', a.prevda?.q2);
  const od = a.onduty ?? {};
  for (const n of [1, 2, 3, 4, 5, 6, 7] as const) {
    const v = od[`h${n}`];
    need('certs', `onduty.h${n}`, `On-duty hours, day ${n}`, v);
  }
  need('certs', 'onduty.relievedTime', 'Last relieved from work: Time', od.relievedTime);
  need('certs', 'onduty.relievedDate', 'Last relieved from work: Date', od.relievedDate);
  yn('certs', 'otherwork.q1', 'Are you currently driving for another motor carrier?', a.otherwork?.q1);
  yn('certs', 'otherwork.q2', 'Do you intend to drive for another motor carrier?', a.otherwork?.q2);

  // 8 Disclosures — acknowledgements of the approved documents
  for (const d of DOT_APP_DOCUMENTS.filter((x) => x.step === 'disclosures' && x.ack && !x.perEntity)) {
    if (ctx.approvedDocs.has(d.key) && !a.ack?.[d.key]) out.push({ step: 'disclosures', key: `ack.${d.key}`, label: `Acknowledge: ${d.title}`, kind: 'field' });
  }
  for (const x of dotAppFcraEntities(a)) {
    for (const [doc, key, what] of [
      ['fcra_disclosure_entity', fcraDisclosureKey(x.id), 'FCRA Disclosure'],
      ['fcra_authorization_entity', fcraAuthorizationKey(x.id), 'FCRA Authorization'],
    ] as const) {
      if (ctx.approvedDocs.has(doc) && !a.ack?.[key]) out.push({ step: 'disclosures', key: `ack.${key}`, label: `Acknowledge: ${what} — ${x.name}`, kind: 'field' });
    }
  }
  if (ctx.approvedDocs.has('clearinghouse_single')) {
    const chs = a.chs ?? {};
    need('disclosures', 'chs.from', 'Clearinghouse single query: period from', chs.from);
    need('disclosures', 'chs.to', 'Clearinghouse single query: period to', chs.to);
    check('disclosures', 'chs.to', 'Clearinghouse single query: the period ends after it starts', chs.to, (v) => !chs.from || !v || v >= chs.from);
  }
  if (a.copy?.requested) {
    need('disclosures', 'copy.email', 'Copy: email address', a.copy.email);
    check('disclosures', 'copy.email', 'Copy: email address (valid)', a.copy.email, dotAppChecks.email);
  }

  // 9 Company policies
  const content = (key: string) => ctx.templateContent?.(key);
  if (ctx.approvedDocs.has('da_receipt')) {
    const n = dotAppItemCount(content('da_receipt'), 12);
    for (let i = 1; i <= n; i++) if (!a.dar?.[`i${i}`]) out.push({ step: 'policies', key: `dar.i${i}`, label: `Alcohol and Drug Receipt: item ${i}`, kind: 'field' });
  }
  if (ctx.approvedDocs.has('ic_ack')) {
    for (const i of dotAppIcaInitialPages(content('ic_ack'))) {
      need('policies', `ica.init${i}`, `Independent Contractor’s Acknowledgement: page ${i + 1} initials`, (a.ica as Record<string, unknown> | undefined)?.[`init${i}`]);
    }
    need('policies', 'ica.printName', 'Independent Contractor’s Acknowledgement: print name', a.ica?.printName);
  }
  if (ctx.approvedDocs.has('handbook_ack')) need('policies', 'hb.printName', 'Handbook Acknowledgement: print name', a.hb?.printName);
  if (ctx.approvedDocs.has('video_consent')) {
    const what = ['video recording', 'audio recording', 'photographs'];
    const n = dotAppItemCount(content('video_consent'), 3, Number.POSITIVE_INFINITY);
    for (let i = 0; i < n; i++) need('policies', `vid.i${i}`, `Video consent: initials (${what[i] ?? `item ${i + 1}`})`, (a.vid as Record<string, unknown> | undefined)?.[`i${i}`]);
  }

  // 10 Contractor forms
  if (isDotAppContractor(a)) {
    if (ctx.approvedDocs.has('w9')) {
      const w = a.w9 ?? {};
      need('contractor', 'w9.name', 'W-9 line 1: Name', w.name);
      need('contractor', 'w9.cls', 'W-9 line 3: federal tax classification', w.cls);
      if (w.cls === 'Limited liability company') need('contractor', 'w9.llc', 'W-9: LLC tax classification', w.llc);
      if (w.cls === 'Other (see instructions)') need('contractor', 'w9.other', 'W-9: Other', w.other);
      need('contractor', 'w9.address', 'W-9 line 5: Address', w.address);
      need('contractor', 'w9.csz', 'W-9 line 6: City, state, and ZIP code', w.csz);
      need('contractor', 'w9.tinType', 'W-9 Part I: TIN type', w.tinType);
      if (w.tinType === 'Employer identification number') need('contractor', 'w9.ein', 'W-9: Employer identification number', w.ein);
    }
    if (ctx.approvedDocs.has('ach_debit')) {
      const h = a.ach ?? {};
      need('contractor', 'ach.name', 'ACH authorization: Print Name (Company Name)', h.name);
      need('contractor', 'ach.address', 'ACH authorization: Address', h.address);
      need('contractor', 'ach.accountType', 'ACH authorization: Checking Account / Saving Account', h.accountType);
      need('contractor', 'ach.bank', 'ACH authorization: Depository Bank Name', h.bank);
      if (!ctx.bankOnFile) out.push({ step: 'contractor', key: 'ach.numbers', label: 'ACH authorization: Routing Number and Account Number', kind: 'field' });
      need('contractor', 'ach.email', 'ACH authorization: Email', h.email);
      check('contractor', 'ach.email', 'ACH authorization: Email (valid address)', h.email, dotAppChecks.email);
    }
    if (ctx.approvedDocs.has('occ_accident')) {
      const o = a.oa ?? {};
      if (!filled(o.fein) && !o.feinNone) out.push({ step: 'contractor', key: 'oa.fein', label: 'Occupational Accident: FEIN Number (or tick None)', kind: 'field' });
      need('contractor', 'oa.years', 'Occupational Accident: Number of Years Experience', o.years);
      yn('contractor', 'oa.sex', 'Occupational Accident: Sex', o.sex);
      need('contractor', 'oa.height', 'Occupational Accident: Height', o.height);
      need('contractor', 'oa.weight', 'Occupational Accident: Weight', o.weight);
      need('contractor', 'oa.beneficiary', 'Occupational Accident: Beneficiary', o.beneficiary);
      need('contractor', 'oa.relationship', 'Occupational Accident: Relationship to Beneficiary', o.relationship);
      for (const q of ['q1', 'q2', 'q3', 'q4', 'q6', 'q7'] as const) yn('contractor', `oa.${q}`, `Occupational Accident: question ${q.slice(1)}`, o[q]);
      if (o.q3 === 'Yes') need('contractor', 'oa.q3who', 'Occupational Accident: for whom?', o.q3who);
      if (o.q4 === 'Yes') need('contractor', 'oa.q4who', 'Occupational Accident: with whom?', o.q4who);
      need('contractor', 'oa.equip', 'Occupational Accident: Equipment type', o.equip);
      if ((o.equip ?? []).includes('Other')) need('contractor', 'oa.equipOther', 'Occupational Accident: Other equipment', o.equipOther);
      if (o.q6 === 'Yes') need('contractor', 'oa.q6ex', 'Occupational Accident: explain the claim', o.q6ex);
      if (o.q7 === 'Yes') need('contractor', 'oa.q7carrier', 'Occupational Accident: insurance carrier', o.q7carrier);
    }
  }

  // Documents the company has not approved yet: shown, and they block Submit.
  const steps = dotAppVisibleSteps(a);
  for (const d of DOT_APP_DOCUMENTS) {
    if (d.textOnly || d.addedLater || d.signer !== 'driver' && !d.ack) continue;
    if (d.contractorOnly && !isDotAppContractor(a)) continue;
    if (!steps.includes(d.step as DotAppStepId)) continue;
    if (d.consentLink && ctx.consentLinks.has(d.consentLink) && !d.ack) continue;
    if (!ctx.approvedDocs.has(d.key)) out.push({ step: d.step as DotAppStepId, key: `doc.${d.key}`, label: `Awaiting approved document: ${d.title}`, kind: 'document' });
  }

  // Signatures, step by step.
  for (const step of steps) {
    for (const key of dotAppSignaturesFor(step, a, ctx)) {
      if (!ctx.approvedDocs.has(signatureDocKey(key))) continue;
      if (!ctx.signatures.has(key)) out.push({ step, key: `sig.${key}`, label: `Signature: ${signatureLabel(key, a)}`, kind: 'signature' });
    }
  }

  // 11 Documents
  for (const u of dotAppUploadSlots(a)) {
    if (u.required && !ctx.uploads.has(u.slot)) out.push({ step: 'documents', key: `upload.${u.slot}`, label: `Upload: ${UPLOAD_LABEL[u.slot]}`, kind: 'upload' });
  }
  return out;
}

const UPLOAD_LABEL: Record<DotAppUploadSlot, string> = {
  cdl_front: 'CDL — front',
  cdl_back: 'CDL — back',
  med_card: 'DOT medical card',
  twic: 'TWIC card',
  registration: 'Truck registration',
  other: 'Other document',
};

export function signatureLabel(key: string, a?: DotAppAnswers): string {
  const employer = (id: string) => (a?.employers ?? []).find((x) => x.id === id)?.company;
  const entity = (id: string) => employer(id) ?? (a?.schools ?? []).find((x) => x.id === id)?.school;
  const named = (base: string, name: string | undefined) => `${base}${name ? ` — ${name}` : ''}`;
  if (key.startsWith('sph_')) return named('Safety Performance History request', employer(key.slice(4)));
  if (key.startsWith('ev_')) return named('Request/Consent for Safety Performance History (391.23)', employer(key.slice(3)));
  if (key.startsWith('fcrad_')) return named('FCRA Disclosure for Consumer Reports', entity(key.slice(6)));
  if (key.startsWith('fcraa_')) return named('FCRA Authorization for Consumer Reports', entity(key.slice(6)));
  if (key === 'emp_training_driver') return 'Driver Safety Training — driver signature (in person)';
  return DOT_APP_DOCUMENTS.find((d) => d.key === key)?.title ?? key;
}

export function dotAppStepTitle(step: DotAppStepId): string {
  return DOT_APP_STEP_TITLES[step];
}
