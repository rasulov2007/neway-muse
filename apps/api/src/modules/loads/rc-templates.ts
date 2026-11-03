import type { RateConfirmationExtract, RcStop } from '@neway/shared';

/**
 * Templates for brokers we see every day: their RC layout never changes, so a few exact rules read
 * it in milliseconds, for free, and without the mistakes a small model makes. A broker without a
 * template (or a template that cannot find the rate and both ends of the route) goes to the model.
 *
 * Each template works on `pdftotext -layout` text.
 *
 * The public snapshot ships only the generic McLeod "Load Confirmation" layout; the per-broker
 * templates written from real rate confirmations are kept private.
 */
export interface RcTemplate {
  id: string;
  matches(text: string): boolean;
  read(text: string): RateConfirmationExtract | null;
}

const num = (s: string | undefined) => (s ? Number(s.replace(/,/g, '')) : null);
const lines = (text: string) => text.replace(/\f/g, '\n').split('\n');

/** MM/DD/YY or MM/DD/YYYY -> YYYY-MM-DD. */
export function isoDate(s: string): string | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);
  if (!m) return null;
  const year = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  return `${year}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

/**
 * Operational terms worth a line in the load's notes, when the RC says them. Short, in the
 * dispatcher's words; the RC itself stays attached for the full text.
 */
const NOTE_RULES: Array<[RegExp, (m: RegExpMatchArray) => string]> = [
  [
    /POSTAL FORM\s+5398 OR 5397/i,
    () => 'Signed postal form 5398/5397 required; HCR and trip # must match or no payment.',
  ],
  [/MacroPoint[^$]{0,120}\$(\d+)/i, (m) => `MacroPoint tracking required ($${m[1]} if off).`],
  [
    /Late deliveries and missed appointments subject to a \$(\d+) fine per day/i,
    (m) => `Late/missed appointment: $${m[1]}/day.`,
  ],
  [/FCFS will not pay detention/i, () => 'FCFS loads: no detention.'],
  [/SAFETY VESTS/i, () => 'Driver: safety vest, closed shoes.'],
  [/(\d+) RATCHET STRAPS/i, (m) => `${m[1]} ratchet straps, E-tracks, padlock.`],
  [/POSSIBLE DRIVER ASSIST; NOT GOING TO BE PAID/i, () => 'Driver assist possible, unpaid.'],
];

export function notesFrom(text: string, max = 450): string | null {
  const out: string[] = [];
  for (const [re, say] of NOTE_RULES) {
    const m = text.match(re);
    if (m) out.push(say(m));
  }
  const joined = out.join(' ');
  return joined ? joined.slice(0, max) : null;
}

/** EVE International Logistics - USPS mail runs, one PICK and numbered STOPs. */
const STREET_SUFFIX =
  /\b(RD|ROAD|ST|STREET|AVE|AVENUE|DR|DRIVE|WAY|BLVD|PKWY|PARKWAY|LN|LANE|HWY|HIGHWAY|TPKE|PIKE|CT|COURT|PL|PLACE|CIR|TRL|TER|LOOP|SQ|EXPY|ROUTE|RTE)\b\.?((?:\s+(?:STE|SUITE|UNIT|BLDG|#)\s*\S+)*)/gi;

/** "850 NEWARK TPKE KEARNY" -> street "850 NEWARK TPKE", city "KEARNY" (the last street suffix ends the street). */
export function splitStreetCity(s: string): { street: string | null; city: string | null } {
  const text = s.trim().replace(/,$/, '');
  let end = -1;
  for (const m of text.matchAll(STREET_SUFFIX)) end = (m.index ?? 0) + m[0].length;
  if (end <= 0 || end >= text.length) return { street: null, city: text || null };
  return {
    street: text.slice(0, end).trim(),
    city:
      text
        .slice(end)
        .replace(/^[,\s]+/, '')
        .trim() || null,
  };
}

/** "1:00PM" / "2:00:00 PM" / "0830" / "13:10" -> "HH:mm". */
export function hhmm(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim().toUpperCase();
  let m = t.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*([AP]M)?$/);
  if (!m) {
    const four = t.match(/^(\d{2})(\d{2})$/);
    if (four) m = ['', four[1]!, four[2]!, undefined] as unknown as RegExpMatchArray;
  }
  if (!m) return null;
  let h = Number(m[1]);
  if (m[3] === 'PM' && h < 12) h += 12;
  if (m[3] === 'AM' && h === 12) h = 0;
  return h > 23 ? null : `${String(h).padStart(2, '0')}:${m[2]}`;
}

/** "Sep 30, 2026" / "09-29-2026" / "9/30/2026" -> YYYY-MM-DD. */
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function anyDate(s: string | undefined | null): string | null {
  if (!s) return null;
  const t = s.trim();
  const words = t.match(/^([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/);
  if (words) {
    const month = MONTHS.indexOf(words[1]!.toLowerCase()) + 1;
    return month
      ? `${words[3]}-${String(month).padStart(2, '0')}-${words[2]!.padStart(2, '0')}`
      : null;
  }
  return isoDate(t.replace(/-/g, '/'));
}

const stop = (kind: 'pickup' | 'delivery', over: Partial<RcStop>): RcStop => ({
  kind,
  facilityName: null,
  street: null,
  city: null,
  state: null,
  zip: null,
  date: null,
  time: null,
  endTime: null,
  reference: null,
  ...over,
});

const equipmentOf = (s: string | undefined | null): RateConfirmationExtract['equipment'] =>
  !s
    ? null
    : /reefer/i.test(s)
      ? 'reefer'
      : /flat|step\s*deck|rgn/i.test(s)
        ? 'flatbed'
        : /van/i.test(s)
          ? 'dry_van'
          : null;

const base = (over: Partial<RateConfirmationExtract>): RateConfirmationExtract => ({
  brokerName: null,
  brokerMc: null,
  brokerLoadNumber: null,
  totalRate: null,
  linehaulRate: null,
  commodity: null,
  weightLbs: null,
  equipment: null,
  hazmat: null,
  temperature: null,
  miles: null,
  stops: [],
  notes: null,
  warnings: [],
  ...over,
});

/** A template's answer only counts when it found the money and both ends of the route. */
const complete = (e: RateConfirmationExtract) =>
  e.brokerLoadNumber && e.totalRate && e.stops.length >= 2 && e.stops.every((s) => s.city && s.date)
    ? e
    : null;

/* ------------------------------------------------------------------------------------------------ */

const mcleod: RcTemplate = {
  id: 'mcleod-load-confirmation',
  matches: (t) =>
    /\b(PU|SO)\s+\d\b/.test(t) &&
    /Name:/.test(t) &&
    /(Total Carrier Pay|Total Pay|Carrier Freight Pay)/.test(t),
  read(text) {
    const all = lines(text);
    const stops: RcStop[] = [];
    all.forEach((line, i) => {
      if (!/Name:/.test(line) || !/Date:/.test(line)) return;
      const kindLine = `${line} ${all[i + 1] ?? ''} ${all[i - 1] ?? ''}`;
      const kind = /\bPU\s+\d/.test(kindLine)
        ? 'pickup'
        : /\bSO\s+\d/.test(kindLine)
          ? 'delivery'
          : null;
      if (!kind) return;
      const name = line.match(/Name:\s*(.+?)\s{2,}Date:/)?.[1]?.trim() ?? null;
      const d1 = line.match(/Date:\s*(\S+)\s+(\d{4})/);
      const d2 = (all[i + 1] ?? '').match(/(\d{2}\/\d{2}\/\d{4})\s+(\d{4})\s*$/);
      const window = all.slice(i + 1, i + 9);
      const street =
        window
          .map((l) =>
            l
              .replace(/^.*Address:\s*/, '')
              .split(/\s{3,}/)
              .find((c) => /^\d+[A-Z]?\s+\S/.test(c.trim()))
              ?.trim(),
          )
          .find(Boolean) ?? null;
      const cityLine = window
        .map((l) => l.trim().match(/^(?:.*?\s{2,})?([A-Z][A-Z .'-]+?)\s{2,}([A-Z]{2})\s+(\d{5})\b/))
        .find(Boolean);
      stops.push(
        stop(kind, {
          facilityName: name,
          street,
          city: cityLine?.[1]?.trim() ?? null,
          state: cityLine?.[2] ?? null,
          zip: cityLine?.[3] ?? null,
          date: d1 ? isoDate(d1[1]!) : null,
          time: hhmm(d1?.[2]),
          endTime: d2 && d2[1] === d1?.[1] ? hhmm(d2[2]) : null,
          reference:
            window
              .join('\n')
              .match(/Reference number:\s*(.+)/i)?.[1]
              ?.trim() ?? null,
        }),
      );
    });
    // The broker's name sits in the RC's letterhead, which this generic layout does not mark;
    // the reader leaves it empty and the dispatcher picks the broker.
    const broker: string | null = null;
    const commodity = text.match(/Commodity:\s+([A-Za-z][^\n]*?)\s{2,}/)?.[1] ?? null;
    return base({
      brokerName: broker,
      brokerMc: text.match(/^\s*MC\s+(\d+)\b/m)?.[1] ?? null,
      brokerLoadNumber:
        text.match(/Load Number:\s*(\d+)/)?.[1] ?? text.match(/Order:\s*(\d+)/)?.[1] ?? null,
      totalRate: num(text.match(/Total (?:Carrier )?Pay:?\s*\$?([\d,]+\.\d{2})/)?.[1]),
      weightLbs: num(text.match(/Weight:\s*([\d,.]+)/)?.[1]),
      miles: num(text.match(/Miles:\s*([\d,.]+)/)?.[1]),
      equipment: equipmentOf(text.match(/Trailer(?: Type)?:\s*(.+?)(?:\s{2,}|$)/m)?.[1]),
      commodity: commodity && !/Pieces|Weight/.test(commodity) ? commodity : null,
      stops,
      notes: notesFrom(text) ?? mcleodNotes(text),
    });
  },
};

function mcleodNotes(text: string): string | null {
  const out: string[] = [];
  if (/MACROPOINT \((\d+)% OF RATE\)/i.test(text))
    out.push(`MacroPoint required (${text.match(/MACROPOINT \((\d+)% OF RATE\)/i)![1]}% of rate).`);
  if (/Trucker Tools/i.test(text)) out.push('Trucker Tools tracking required.');
  if (/SWING DOORS/i.test(text)) out.push('Swing doors and E-tracks.');
  if (/Detention Rate - \$(\d+)\/hr/.test(text))
    out.push(`Detention $${text.match(/Detention Rate - \$(\d+)\/hr/)![1]}/h after 2 h.`);
  if (/notify broker 30 minutes prior to the start of detention/i.test(text))
    out.push('Notify broker 30 min before detention.');
  return out.join(' ') || null;
}


export const RC_TEMPLATES: RcTemplate[] = [mcleod];

/** Blank lines carry nothing in a layout and only break the multi-line rules. */
export function normalizeLayout(raw: string): string {
  return raw.replace(/\r/g, '').replace(/\f/g, '\n').replace(/\n[^\S\n]*(?=\n)/g, '');
}

/** The template's reading, or null when no template knows this RC. */
export function readWithTemplate(
  raw: string,
): { extract: RateConfirmationExtract; template: string } | null {
  const text = normalizeLayout(raw);
  for (const t of RC_TEMPLATES) {
    if (!t.matches(text)) continue;
    const extract = t.read(text);
    if (extract && complete(extract)) return { extract, template: t.id };
  }
  return null;
}
