import { z } from 'zod';

/**
 * The driver's answers, as saved by autosave. Paths follow the source form section by section
 * (personal.*, company.*, licenses[], employers[] …). Drafts are lenient on purpose — a half-filled
 * section saves — and `dotAppMissing` decides what is still needed before Submit, the same rule on
 * the phone and on the server. The SSN never lives in here: it is sent separately and sealed.
 */

type Yn = string;
export interface DotAppAddress {
  street?: string;
  /** Address 2 (WB-app employer blocks print it). */
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country?: string;
}
export interface DotAppPrevAddress extends DotAppAddress {
  from?: string;
  to?: string;
}
export interface DotAppEquipment {
  type?: string;
  year?: string;
  make?: string;
  model?: string;
  color?: string;
  vin?: string;
  weight?: string;
  mileage?: string;
  fifth?: string;
}
export interface DotAppLicense {
  number?: string;
  authority?: string;
  country?: string;
  cls?: string;
  exp?: string;
  med?: string;
  current?: Yn;
  cdl?: Yn;
  endorse?: string[];
}
export interface DotAppEmployer {
  /** Stable id (client-made): the Safety Performance History request is signed per employer id. */
  id?: string;
  company?: string;
  start?: string;
  end?: string;
  address?: DotAppAddress;
  phone?: string;
  fax?: string;
  position?: string;
  reason?: string;
  terminated?: Yn;
  current?: Yn;
  contact?: Yn;
  cmv?: Yn;
  fmcsr?: Yn;
  dotTesting?: Yn;
  areas?: string[];
  miles?: string;
  truck?: string;
  trailer?: string;
  trailerLen?: string;
}
export interface DotAppPeriod {
  start?: string;
  end?: string;
  comment?: string;
}
export interface DotAppSchool {
  /** Stable id (client-made): the per-school FCRA Disclosure / Authorization is signed per id. */
  id?: string;
  start?: string;
  end?: string;
  school?: string;
  address?: string;
  address2?: string;
  city?: string;
  country?: string;
  phone?: string;
  gpa?: string;
  hours?: string;
  graduated?: Yn;
  fmcsr?: Yn;
  dotTesting?: Yn;
  subjects?: string[];
}
export interface DotAppAccident {
  date?: string;
  location?: string;
  injuries?: string;
  fatalities?: string;
  hazmat?: Yn;
  cmv?: Yn;
  desc?: string;
}
export interface DotAppViolation {
  date?: string;
  state?: string;
  charge?: string;
  mph?: string;
  fine?: string;
  cmv?: Yn;
  fined?: Yn;
  suspended?: Yn;
  revoked?: Yn;
  community?: Yn;
  otherPenalty?: Yn;
  comments?: string;
}
export interface DotAppContact {
  name?: string;
  relationship?: string;
  address?: string;
  csz?: string;
  phone?: string;
  alt?: string;
}

export interface DotAppAnswers {
  personal?: {
    firstName?: string;
    middleName?: string;
    lastName?: string;
    suffix?: string;
    address?: DotAppAddress;
    res3?: Yn;
    prevAddresses?: DotAppPrevAddress[];
    dob?: string;
    phone?: string;
    email?: string;
    emailOptIn?: boolean;
    smsOptIn?: Yn;
  };
  company?: {
    position?: string;
    location?: string;
    isOwner?: Yn;
    equipment?: DotAppEquipment[];
    eligible?: Yn;
    employed?: Yn;
    lastEnd?: string;
    english?: Yn;
    workedBefore?: Yn;
    workedBeforeDetails?: string;
    twic?: Yn;
    twicExp?: string;
    otherName?: Yn;
    otherNameText?: string;
    heard?: string;
    referral?: string;
    heardOther?: string;
  };
  exp?: { straight?: string; tractorSemi?: string; twoTrailers?: string; other?: string };
  licenses?: DotAppLicense[];
  employers?: DotAppEmployer[];
  unemployment?: DotAppPeriod[];
  schools?: DotAppSchool[];
  fmcsr?: { disqualified?: Yn; suspended?: Yn; denied?: Yn; preEmpPositive?: Yn; convicted?: Yn };
  accidents?: { any?: Yn; list?: DotAppAccident[] };
  violations?: { any?: Yn; list?: DotAppViolation[] };
  criminal?: { convicted?: Yn; deferred?: Yn; pending?: Yn; felony?: Yn; canadaPermit?: Yn; misdemeanor?: Yn; explain?: string };
  emergency?: {
    c1?: DotAppContact;
    c2?: DotAppContact;
    allergies?: Yn;
    allergiesList?: string;
    health?: Yn;
    healthList?: string;
    physician?: string;
    physicianPhone?: string;
  };
  /** Certification of Violations (past 12 months). */
  cov?: { none?: boolean; list?: { date?: string; offense?: string; location?: string; vehicle?: string }[] };
  prevda?: { q1?: Yn; q2?: Yn };
  onduty?: {
    end?: string;
    rest?: string;
    h1?: string;
    h2?: string;
    h3?: string;
    h4?: string;
    h5?: string;
    h6?: string;
    h7?: string;
    relievedTime?: string;
    relievedDate?: string;
  };
  otherwork?: { q1?: Yn; q2?: Yn };
  /** Acknowledgement checkboxes, by document key. */
  ack?: Record<string, boolean>;
  /** Per previous employer (by employer id): where Safety sends the request. */
  sph?: Record<string, { email?: string; fax?: string }>;
  copy?: { requested?: boolean; email?: string };
  /** General Consent for a single limited Clearinghouse query (WB-hir p.2): the query period. */
  chs?: { from?: string; to?: string };
  /**
   * ACH debit authorization (WB-hir p.6). The routing and account numbers are NEVER kept here:
   * they travel in `bank` on a save and are sealed on the application (like the SSN).
   */
  ach?: { name?: string; address?: string; accountType?: string; bank?: string; email?: string };
  /** Alcohol and Drug Certified Receipt: items i1…i12 (+ optional i13), optional information. */
  dar?: Record<string, boolean | string | undefined>;
  /** Independent Contractor's Acknowledgement: page initials init0 / init1, printed name. */
  ica?: { init0?: string; init1?: string; printName?: string };
  hb?: { printName?: string };
  /** Video consent initials i0 (video) i1 (audio) i2 (photographs). */
  vid?: { i0?: string; i1?: string; i2?: string };
  w9?: {
    name?: string;
    business?: string;
    cls?: string;
    llc?: string;
    other?: string;
    exemptPayee?: string;
    fatca?: string;
    address?: string;
    csz?: string;
    accounts?: string;
    tinType?: string;
    ein?: string;
    crossItem2?: boolean;
  };
  oa?: {
    fein?: string;
    /** FEIN Number "None" box. */
    feinNone?: boolean;
    years?: string;
    sex?: string;
    height?: string;
    weight?: string;
    homePhone?: string;
    beneficiary?: string;
    relationship?: string;
    q1?: Yn;
    q2?: Yn;
    q3?: Yn;
    q3who?: string;
    q4?: Yn;
    q4who?: string;
    equip?: string[];
    equipOther?: string;
    q6?: Yn;
    q6ex?: string;
    q7?: Yn;
    q7carrier?: string;
  };
}

/**
 * Answers are free-shaped JSON with hard bounds: strings ≤ 4,000, arrays ≤ 60 items, depth ≤ 6,
 * plain values only. The shape above is what the screens write; the server stores what passes.
 */
const MAX_STRING = 4000;
const MAX_ARRAY = 60;
const MAX_DEPTH = 6;
function bounded(value: unknown, depth: number): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= MAX_STRING;
  if (depth >= MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.length <= MAX_ARRAY && value.every((v) => bounded(v, depth + 1));
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length <= 120 && entries.every(([k, v]) => k.length <= 60 && !k.startsWith('__') && bounded(v, depth + 1));
  }
  return false;
}
export const DotAppAnswersSchema = z
  .record(z.string(), z.unknown())
  .refine((v) => bounded(v, 0), 'The answers are too large or not plain values.')
  .refine((v) => JSON.stringify(v).length <= 256 * 1024, 'The answers are too large.')
  .transform((v) => v as DotAppAnswers);

export const SaveDotAppSchema = z.object({
  /** The version the page read; a stale save is refused with 409 and the newer copy. */
  version: z.number().int().min(1),
  answers: DotAppAnswersSchema,
  /** Only when the driver typed or changed it: 9 digits; never echoed back. */
  ssn: z
    .string()
    .trim()
    .regex(/^\d{3}-?\d{2}-?\d{4}$/, 'Enter a 9-digit SSN (XXX-XX-XXXX).')
    .optional(),
  /** ACH debit bank numbers, only when typed or changed: sealed on the server, never echoed back. */
  bank: z
    .object({
      routing: z.string().trim().regex(/^\d{9}$/, 'Enter the 9-digit routing number.').refine(abaRoutingValid, 'This routing number is not valid. Check the 9 digits.'),
      account: z.string().trim().regex(/^\d{4,17}$/, 'Enter the account number (4 to 17 digits).'),
    })
    .optional(),
});
export type SaveDotAppInput = z.infer<typeof SaveDotAppSchema>;

/** ABA routing number checksum: 3·(d1+d4+d7) + 7·(d2+d5+d8) + (d3+d6+d9) ≡ 0 (mod 10). */
export function abaRoutingValid(routing: string): boolean {
  if (!/^\d{9}$/.test(routing)) return false;
  const d = [...routing].map(Number);
  const sum = 3 * (d[0]! + d[3]! + d[6]!) + 7 * (d[1]! + d[4]! + d[7]!) + (d[2]! + d[5]! + d[8]!);
  return sum % 10 === 0 && routing !== '000000000';
}

export const DOT_APP_ACH_ACCOUNT_TYPES = ['Checking Account', 'Saving Account'] as const;

export const DOT_APP_CONTRACTOR_POSITIONS = ['Contract Driver (1099)', 'Owner Operator', 'Fleet Owner', 'Lease Purchase'] as const;
export const DOT_APP_OWNER_POSITIONS = ['Owner Operator', 'Fleet Owner'] as const;
export function isDotAppContractor(a: DotAppAnswers): boolean {
  return (DOT_APP_CONTRACTOR_POSITIONS as readonly string[]).includes(a.company?.position ?? '');
}
export function isDotAppOwner(a: DotAppAnswers): boolean {
  return (DOT_APP_OWNER_POSITIONS as readonly string[]).includes(a.company?.position ?? '');
}

/**
 * Option lists. The source printout is a blank form and does not print its dropdown choices; these
 * lists were approved by the owner on 2026-10-27 (not legal wording).
 */
export const DOT_APP_OPTIONS = {
  position: ['Company Driver', 'Contract Driver (1099)', 'Owner Operator', 'Fleet Owner', 'Lease Purchase'],
  heard: ['Instagram', 'Facebook', 'Indeed', 'Google', 'Driver Referral', 'Website', 'Other'],
  yearsExp: ['None', 'Less than 1 year', '1 year', '2 years', '3 years', '4 years', '5 years', '6–10 years', 'More than 10 years'],
  licClass: ['Class A', 'Class B', 'Class C', 'Non-CDL'],
  endorse: ['H — Hazardous materials', 'N — Tank vehicle', 'T — Double/Triple trailers', 'X — Hazmat + Tank', 'P — Passenger', 'S — School bus'],
  country: ['United States', 'Canada', 'Mexico'],
  truck: ['Tractor', 'Straight Truck', 'Box Truck', 'Other'],
  trailer: ['Dry Van', 'Reefer', 'Flatbed', 'Step Deck', 'Tanker', 'Car Hauler', 'Intermodal', 'Other'],
  trailerLen: ['28 ft', '40 ft', '45 ft', '48 ft', '53 ft', 'Other'],
  areas: ['Local', 'Regional', 'OTR — 48 states', 'Canada', 'Mexico'],
  suffix: ['Jr.', 'Sr.', 'II', 'III', 'IV'],
  states: 'AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY'.split(' '),
  schoolSubjects: ['Border Crossing', 'Log Books', 'Federal Motor Carrier Regulations', 'Hazardous Materials'],
  w9Class: ['Individual/sole proprietor or single-member LLC', 'C Corporation', 'S Corporation', 'Partnership', 'Trust/estate', 'Limited liability company', 'Other (see instructions)'],
  oaEquip: ['Box', 'Flatbed', 'Intermodal', 'Tanker', 'Refrigerated', 'Dump', 'Straight Truck', 'Other'],
} as const;
