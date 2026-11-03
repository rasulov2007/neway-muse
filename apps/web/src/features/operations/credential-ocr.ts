/**
 * Reading a licence and a medical card.
 *
 * Both are photographed on a phone by whoever is onboarding the driver, and both carry the two
 * dates the compliance engine runs on. Typing those dates is where they go wrong: a transposed
 * digit in a medical expiry is a driver who looks qualified for eleven months longer than he is.
 *
 * So the card is read, and what is read is *offered* — never accepted. Every extracted value lands
 * in an ordinary form field the person can see and correct before anything is saved, and a card
 * that cannot be read says so and leaves the field empty rather than guessing.
 *
 * The recognition runs in the browser (tesseract.js). The photograph of somebody's licence is not
 * uploaded anywhere to be read: it stays on the machine of the person holding it, and only travels
 * when the form is submitted, to this company's own document store.
 *
 * Every date here is assembled from digits as a plain `YYYY-MM-DD` string. Nothing goes through
 * `new Date()`, because `new Date('05/14/2029')` is midnight *local* time and formatting it back
 * west of Greenwich returns the 13th — a licence that expires a day early, silently.
 */

export interface CdlExtract {
  licenceNumber: string | null;
  state: string | null;
  cdlClass: 'A' | 'B' | null;
  endorsements: string[];
  expiresOn: string | null;
  issuedOn: string | null;
  firstName: string | null;
  lastName: string | null;
}

export interface MedicalCardExtract {
  expiresOn: string | null;
  issuedOn: string | null;
  examinerName: string | null;
}

/** What the reader could not do, in words the form can show. */
export class OcrUnavailableError extends Error {}

const STATE_NAMES: Record<string, string> = {
  ALABAMA: 'AL',
  ALASKA: 'AK',
  ARIZONA: 'AZ',
  ARKANSAS: 'AR',
  CALIFORNIA: 'CA',
  COLORADO: 'CO',
  CONNECTICUT: 'CT',
  DELAWARE: 'DE',
  FLORIDA: 'FL',
  GEORGIA: 'GA',
  HAWAII: 'HI',
  IDAHO: 'ID',
  ILLINOIS: 'IL',
  INDIANA: 'IN',
  IOWA: 'IA',
  KANSAS: 'KS',
  KENTUCKY: 'KY',
  LOUISIANA: 'LA',
  MAINE: 'ME',
  MARYLAND: 'MD',
  MASSACHUSETTS: 'MA',
  MICHIGAN: 'MI',
  MINNESOTA: 'MN',
  MISSISSIPPI: 'MS',
  MISSOURI: 'MO',
  MONTANA: 'MT',
  NEBRASKA: 'NE',
  NEVADA: 'NV',
  'NEW HAMPSHIRE': 'NH',
  'NEW JERSEY': 'NJ',
  'NEW MEXICO': 'NM',
  'NEW YORK': 'NY',
  'NORTH CAROLINA': 'NC',
  'NORTH DAKOTA': 'ND',
  OHIO: 'OH',
  OKLAHOMA: 'OK',
  OREGON: 'OR',
  PENNSYLVANIA: 'PA',
  'RHODE ISLAND': 'RI',
  'SOUTH CAROLINA': 'SC',
  'SOUTH DAKOTA': 'SD',
  TENNESSEE: 'TN',
  TEXAS: 'TX',
  UTAH: 'UT',
  VERMONT: 'VT',
  VIRGINIA: 'VA',
  WASHINGTON: 'WA',
  'WEST VIRGINIA': 'WV',
  WISCONSIN: 'WI',
  WYOMING: 'WY',
};

/**
 * A printed date as an ISO date, or null.
 *
 * Cards print `MM/DD/YYYY`, `MM-DD-YY` and occasionally `MM DD YYYY`. Two-digit years are read as
 * this century, because a licence that expired in 1929 is not a licence anybody is onboarding.
 */
export function toIsoDate(printed: string): string | null {
  const match = printed
    .trim()
    .match(/^(\d{1,2})\s*[/\-.\s]\s*(\d{1,2})\s*[/\-.\s]\s*(\d{2}|\d{4})$/);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const rawYear = match[3] as string;
  const year = rawYear.length === 2 ? 2000 + Number(rawYear) : Number(rawYear);
  if (month < 1 || month > 12 || day < 1 || day > 31 || year < 1900 || year > 2999) return null;
  // Assembled as text: no Date, no zone, no drift.
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

const DATE_PATTERN = /\b(\d{1,2}\s*[/\-.]\s*\d{1,2}\s*[/\-.]\s*(?:\d{4}|\d{2}))\b/g;

/**
 * What a date on the card is, decided by the label nearest to it.
 *
 * Nearest, not merely present: a card prints `3 DOB 03/12/1984` and `4a ISS 05/14/2025` on
 * adjacent lines, so asking "does DOB appear anywhere before this" throws the issue date away —
 * and could keep a birth date as an expiry.
 */
type DateRole = 'expiry' | 'issue' | 'birth' | 'unknown';

const ROLE_HINTS: Array<{ role: DateRole; hint: string }> = [
  { role: 'expiry', hint: 'EXPIRATION' },
  { role: 'expiry', hint: 'EXPIRES' },
  { role: 'expiry', hint: 'VALID THROUGH' },
  { role: 'expiry', hint: 'VALID UNTIL' },
  { role: 'expiry', hint: '4B' },
  { role: 'expiry', hint: 'EXP' },
  { role: 'issue', hint: 'ISSUED' },
  { role: 'issue', hint: 'ISSUE DATE' },
  { role: 'issue', hint: '4A' },
  { role: 'issue', hint: 'ISS' },
  { role: 'birth', hint: 'BIRTH' },
  { role: 'birth', hint: 'DOB' },
];

function roleFor(before: string): DateRole {
  let best: { role: DateRole; at: number } | null = null;
  for (const { role, hint } of ROLE_HINTS) {
    const at = before.lastIndexOf(hint);
    if (at === -1) continue;
    if (!best || at > best.at) best = { role, at };
  }
  return best?.role ?? 'unknown';
}

/** Every date on the card, in printed order, with what the card called it. */
function datesWithRole(text: string): Array<{ iso: string; role: DateRole }> {
  const found: Array<{ iso: string; role: DateRole }> = [];
  for (const match of text.matchAll(DATE_PATTERN)) {
    const iso = toIsoDate(match[1] as string);
    if (!iso) continue;
    const at = match.index ?? 0;
    found.push({ iso, role: roleFor(text.slice(Math.max(0, at - 24), at).toUpperCase()) });
  }
  return found;
}

function pickDate(dates: Array<{ iso: string; role: DateRole }>, role: DateRole): string | null {
  return dates.find((date) => date.role === role)?.iso ?? null;
}

/** Dates the card did not call a birth date — the only ones a fallback may consider. */
function notBirthDates(dates: Array<{ iso: string; role: DateRole }>): string[] {
  return dates.filter((date) => date.role !== 'birth').map((date) => date.iso);
}

/**
 * The fields on the front of a commercial licence.
 *
 * Read by the AAMVA labels the card is designed around — `4b` for expiry, `9` for class, `9a` for
 * endorsements — with the plain words as a fallback for the states that print them instead. A
 * field the text does not clearly support comes back null; a wrong value that looks right is worse
 * than an empty box, because the empty box gets filled in by a person looking at the card.
 */
export function parseCdlText(raw: string): CdlExtract {
  const text = raw.replace(/\r/g, '');
  const upper = text.toUpperCase();
  const dates = datesWithRole(text);

  // `4b` is the expiry on an AAMVA card; the birth date is `3` and must never be mistaken for it.
  const expiresOn =
    pickDate(dates, 'expiry') ??
    // Otherwise the furthest-out date the card did not call a birth date.
    notBirthDates(dates).sort().at(-1) ??
    null;
  const issuedOn = pickDate(dates, 'issue');

  const licence =
    upper.match(
      /\b(?:4D|DLN|DL\s*NO|LIC(?:ENSE|ENCE)?\s*(?:NO|#))\s*[:.#]?\s*([A-Z0-9-]{5,20})\b/,
    )?.[1] ?? null;

  const classMatch =
    upper.match(/\b(?:9\s*)?CLASS\s*[:.]?\s*([AB])\b/) ?? upper.match(/\bCDL\s*([AB])\b/);
  const cdlClass = classMatch?.[1] === 'A' || classMatch?.[1] === 'B' ? classMatch[1] : null;

  // Same line only: a newline here swallows the next field and reads its letters as
  // endorsements — `END: T` followed by `EXPIRES` would add an X the card never carried.
  const endorsementBlock = upper.match(
    /\b(?:9A[ ]*)?END(?:ORSEMENTS?)?[ ]*[:.]?[ ]*([A-Z][A-Z ,]{0,11})/,
  );
  const endorsements = endorsementBlock
    ? [...new Set((endorsementBlock[1] ?? '').replace(/[^HNTXPS]/g, '').split(''))].filter((code) =>
        ['H', 'N', 'T', 'X'].includes(code),
      )
    : [];

  let state: string | null = null;
  for (const [name, code] of Object.entries(STATE_NAMES)) {
    if (upper.includes(name)) {
      state = code;
      break;
    }
  }

  /*
   * Names, by the numbered fields the card is laid out with (`1` surname, `2` given names)
   * and by the words the states that skip the numbers print instead. A middle initial is
   * not part of the first name.
   */
  const { lastName, firstName } = readNames(upper);

  return {
    licenceNumber: licence,
    state,
    cdlClass,
    endorsements,
    expiresOn,
    issuedOn,
    firstName,
    lastName,
  };
}

/**
 * The medical examiner's certificate.
 *
 * One date matters — the expiry — and the card states it plainly. Where two dates are printed, the
 * later one is the expiry: a certificate cannot expire before it was issued.
 */
export function parseMedicalCardText(raw: string): MedicalCardExtract {
  const text = raw.replace(/\r/g, '');
  const dates = datesWithRole(text);
  const sorted = notBirthDates(dates).sort();

  const expiresOn = pickDate(dates, 'expiry') ?? sorted.at(-1) ?? null;
  const issued = pickDate(dates, 'issue');
  const issuedOn =
    issued ?? (sorted.length > 1 && sorted[0] !== expiresOn ? (sorted[0] ?? null) : null);

  const examiner =
    text.match(
      /(?:EXAMINER|MEDICAL EXAMINER)(?:'?S)?\s*(?:NAME)?\s*[:.]\s*([A-Za-z .,'-]{3,60})/i,
    )?.[1] ?? null;

  return {
    expiresOn,
    issuedOn,
    examinerName: examiner ? examiner.replace(/\s+/g, ' ').trim() : null,
  };
}

/**
 * Words a licence prints that are not somebody's name.
 *
 * Recognition returns the whole face of the card, headings and all, so the fallback below needs to
 * know what a name is *not*. Anything here, and anything carrying a digit, is skipped.
 */
/** Anything printed on the card itself. A line containing one of these is a heading, not a name. */
const CARD_WORDS = [
  'DRIVER',
  'LICENSE',
  'LICENCE',
  'COMMERCIAL',
  'CLASS',
  'ENDORS',
  'REST',
  'NONE',
  'DONOR',
  'VETERAN',
  'SAFE',
  'FEDERAL',
  'IDENTIFICATION',
  'USA',
  'ADDRESS',
  'SIGNATURE',
  'EMERGENCY',
  'CONTACT',
  'EXP',
  'ISS',
  'DOB',
  'SEX',
  'EYES',
  'HAIR',
  'HGT',
  'WGT',
  'UNDER',
  'REAL ID',
  'DUPLICATE',
  'ORGAN',
];

/**
 * The name on the card.
 *
 * Three readings, in order of how much the card is telling us:
 *
 *  1. The AAMVA field numbers — `1` is the family name, `2` the given names. Exact when the
 *     scan keeps them.
 *  2. The words some states print instead (`LN`, `FIRST NAME`).
 *  3. Failing both, the shape of the card itself: the surname and the given names are printed on
 *     their own lines in capitals, above the address, which is the only place on a licence where
 *     two bare all-caps lines sit together. Headings and anything with a digit in it are skipped.
 *
 * A middle initial is dropped: it is not the first name, and a form that fills "JOSEPH R" into a
 * first-name box has to be corrected by hand every time.
 */
function readNames(upper: string): { lastName: string | null; firstName: string | null } {
  const labelled = (patterns: RegExp[]): string | null => {
    for (const pattern of patterns) {
      const match = upper.match(pattern)?.[1];
      if (match) return match.trim();
    }
    return null;
  };

  let last = labelled([
    /^[ ]*1[ ]+([A-Z][A-Z'-]+)[ ]*$/m,
    /\b(?:LN|LAST(?:[ ]*NAME)?)[ ]*[:.]?[ ]*([A-Z'-]{2,})\b/,
  ]);
  let first = labelled([
    /^[ ]*2[ ]+([A-Z][A-Z'-]+)\b/m,
    /\b(?:FN|FIRST(?:[ ]*NAME)?)[ ]*[:.]?[ ]*([A-Z'-]{2,})\b/,
  ]);

  if (!last || !first) {
    /*
     * The shape of the card.
     *
     * Above the address, a licence prints the surname and the given names on their own lines in
     * capitals — the only place two bare all-caps lines sit together. Anything carrying a digit is
     * an address, a date or a number; anything carrying a word a licence prints on itself is a
     * heading, not a person.
     */
    const candidates = upper
      .split('\n')
      .map((line) =>
        line
          .trim()
          .replace(/[^A-Z' -]/g, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
      )
      .filter(
        (line) =>
          line.length >= 2 &&
          line.length <= 26 &&
          line.split(' ').length <= 2 &&
          /^[A-Z][A-Z' -]*$/.test(line) &&
          !STATE_NAMES[line] &&
          !CARD_WORDS.some((word) => line.includes(word)),
      );

    // One line carrying both ("STETSON JOEL") is the only two-word case that means two names.
    if (candidates.length === 1 && candidates[0]?.includes(' ')) {
      const [family, given] = (candidates[0] as string).split(' ');
      last = last ?? family ?? null;
      first = first ?? given ?? null;
    } else {
      last = last ?? candidates[0] ?? null;
      first = first ?? candidates[1] ?? null;
    }
  }

  // "JOSEPH R" — the initial belongs to neither box.
  const trim = (value: string | null) => value?.split(' ')[0] ?? null;
  return { lastName: titleCase(trim(last)), firstName: titleCase(trim(first)) };
}

function titleCase(value: string | null): string | null {
  if (!value) return null;
  return value
    .toLowerCase()
    .replace(
      /(^|[\s'-])([a-z])/g,
      (_, lead: string, letter: string) => lead + letter.toUpperCase(),
    );
}

/** Files the reader can actually look at. A PDF is stored, but not read. */
export function isReadable(file: File): boolean {
  return file.type === 'image/jpeg' || file.type === 'image/png';
}

/**
 * The text on a photograph, read here in the browser.
 *
 * The engine and its language data are fetched on first use and are a few megabytes, so this is
 * imported only when somebody actually attaches a card — the form costs nothing until then.
 */
export async function readCardText(
  file: File,
  onProgress?: (fraction: number) => void,
): Promise<string> {
  if (!isReadable(file)) {
    throw new OcrUnavailableError('A PDF is kept as filed, but only a photo can be read.');
  }
  let recognize: typeof import('tesseract.js').recognize;
  try {
    ({ recognize } = await import('tesseract.js'));
  } catch {
    throw new OcrUnavailableError('The card reader could not be loaded.');
  }
  const result = await recognize(file, 'eng', {
    logger: (message: { status: string; progress: number }) => {
      if (message.status === 'recognizing text') onProgress?.(message.progress);
    },
  });
  return result.data.text ?? '';
}

/** The file as base64, without the `data:` prefix the store has no use for. */
export function toBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result);
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error('unreadable'));
    reader.readAsDataURL(file);
  });
}

/**
 * The two cards as one structured file.
 *
 * `parseCdlText` and `parseMedicalCardText` answer what each card says; this assembles the file
 * Safety keeps and marks what the reader was unsure of. A field is flagged for review when the
 * card was read but that field did not come out of it — the person then checks one box instead of
 * re-reading the whole licence.
 */
export function toCdlExtract(input: {
  cdlText?: string | null;
  medicalText?: string | null;
}): import('@neway/shared').CdlExtract {
  const cdl = input.cdlText ? parseCdlText(input.cdlText) : null;
  const medical = input.medicalText ? parseMedicalCardText(input.medicalText) : null;
  const needsReview: string[] = [];
  const check = (field: string, value: unknown, wasRead: boolean) => {
    if (wasRead && (value === null || value === undefined || value === '')) needsReview.push(field);
    return value;
  };

  return {
    legalFirstName:
      (check('legalFirstName', cdl?.firstName ?? null, Boolean(cdl)) as string) ?? null,
    legalMiddleName: null,
    legalLastName: (check('legalLastName', cdl?.lastName ?? null, Boolean(cdl)) as string) ?? null,
    // The reader does not take a date of birth off a card: mistaking it for an expiry is the one
    // error that matters most, so it is left for a person.
    dateOfBirth: null,
    cdlNumber: (check('cdlNumber', cdl?.licenceNumber ?? null, Boolean(cdl)) as string) ?? null,
    issuingState: (check('issuingState', cdl?.state ?? null, Boolean(cdl)) as string) ?? null,
    cdlClass: (cdl?.cdlClass ?? null) as 'A' | 'B' | 'C' | null,
    cdlIssuedOn: cdl?.issuedOn ?? null,
    cdlExpiresOn: (check('cdlExpiresOn', cdl?.expiresOn ?? null, Boolean(cdl)) as string) ?? null,
    endorsements: cdl?.endorsements ?? [],
    restrictions: [],
    medicalIssuedOn: medical?.issuedOn ?? null,
    medicalExpiresOn:
      (check('medicalExpiresOn', medical?.expiresOn ?? null, Boolean(medical)) as string) ?? null,
    medicalCertificateNumber: null,
    medicalExaminerName: medical?.examinerName ?? null,
    needsReview,
    source: cdl || medical ? 'ocr' : 'manual',
  };
}
