import type { Load, LoadDocument, LoadStatus } from './types';

/**
 * What has to be on file before a load may claim a status.
 *
 * A status is a claim about custody: *assigned* says a broker agreed a rate, *in transit* says a
 * shipper handed the freight over, *delivered* says a consignee signed for it. Each of those
 * claims has a piece of paper behind it, and a load that reaches delivered with no POD is an
 * invoice nobody can support — the paperwork gets chased weeks later, by which time the driver
 * has lost the signed copy.
 *
 * So the rule lives here, in one place, and both the screen and the store read it. The screen
 * uses it to ask for what is missing; the store uses it to refuse a write. A disabled button is a
 * courtesy, not a control: anything that can call `updateLoad` can call it without the button.
 *
 * Two things it deliberately does not do:
 *
 *  - It never looks backwards. A load that is already delivered with no POD stays delivered; the
 *    rule gates the *move*, and rewriting history to satisfy a rule introduced today would erase
 *    what actually happened.
 *  - It never blocks the way out. Cancelled and TONU are how a load that never ran gets closed
 *    off, and demanding a bill of lading for freight that was never loaded would leave dead loads
 *    stuck on the board forever.
 */

/** The three documents a load's own lifecycle depends on. Invoices and lumper receipts are money. */
export type RequiredDocumentType = Extract<
  LoadDocument['type'],
  'rate_confirmation' | 'bol' | 'pod'
>;

export const REQUIRED_DOCUMENT_ORDER: readonly RequiredDocumentType[] = [
  'rate_confirmation',
  'bol',
  'pod',
];

export const REQUIRED_DOCUMENT_LABEL: Record<
  RequiredDocumentType,
  { short: string; full: string; upload: string }
> = {
  rate_confirmation: {
    short: 'RC',
    full: 'Rate confirmation',
    upload: 'Upload rate confirmation',
  },
  bol: { short: 'BOL', full: 'Bill of lading', upload: 'Upload BOL' },
  pod: { short: 'POD', full: 'Proof of delivery', upload: 'Upload POD' },
};

/**
 * The paperwork each status stands on.
 *
 * `booked` asks for nothing: a load is booked the moment it is entered, which is usually the
 * minute before the rate confirmation comes back over email.
 */
export const DOCUMENTS_REQUIRED_FOR: Record<LoadStatus, readonly RequiredDocumentType[]> = {
  booked: [],
  // Somebody's truck is now committed to this freight, so the rate has to be in writing.
  assigned: ['rate_confirmation'],
  dispatched: ['rate_confirmation'],
  at_pickup: ['rate_confirmation'],
  loading: ['rate_confirmation'],
  // The shipper has handed the freight over; the bill of lading is that handover.
  loaded: ['rate_confirmation', 'bol'],
  in_transit: ['rate_confirmation', 'bol'],
  at_delivery: ['rate_confirmation', 'bol'],
  unloading: ['rate_confirmation', 'bol'],
  // Delivered is what a customer is billed from, so the signed copy is not optional.
  delivered: ['rate_confirmation', 'bol', 'pod'],
  closed: ['rate_confirmation', 'bol', 'pod'],
  // A load that never ran still has to be closable.
  cancelled: [],
  tonu: [],
};

/**
 * Whether a document record is a document, rather than the shape of one.
 *
 * Three things look alike in the list and are not: the placeholder the UI keeps for paperwork
 * that has not arrived (`missing`), an upload nobody has received into the file (`pending` with
 * no review state - the pre-P0.5 shape), and a filed document. A filed document is one a person
 * uploaded (`review` received, reviewed or verified) or one verified before review states
 * existed. Verified is a person's word about the contents; the status gate asks only that the
 * paper exists.
 *
 * The bytes are not part of the test. Seeded and legacy paperwork was filed before this build
 * stored files inline, and treating those loads as unpapered would block every one of them.
 */
export function isQualifyingDocument(doc: LoadDocument): boolean {
  if (doc.status === 'missing') return false;
  const filed = doc.status === 'verified' || doc.review !== undefined;
  if (!filed) return false;
  return doc.fileName.trim() !== '' && doc.uploadedAt.trim() !== '';
}

/** The filed document of that type, or null when only a placeholder or nothing is there. */
export function qualifyingDocument(
  load: Pick<Load, 'documents'>,
  type: RequiredDocumentType,
): LoadDocument | null {
  return load.documents.find((doc) => doc.type === type && isQualifyingDocument(doc)) ?? null;
}

/** What this load still owes before it may claim `target`, in filing order. */
export function missingDocumentsFor(
  load: Pick<Load, 'documents'>,
  target: LoadStatus,
): RequiredDocumentType[] {
  // A status this table has never heard of asks for nothing rather than throwing: an unknown
  // status is a bug to find, not a load to strand.
  const required = DOCUMENTS_REQUIRED_FOR[target] ?? [];
  return required.filter((type) => !qualifyingDocument(load, type));
}

/** `a rate confirmation and a POD`, for a sentence a dispatcher reads. */
export function describeDocuments(types: readonly RequiredDocumentType[]): string {
  const names = types.map((type) => REQUIRED_DOCUMENT_LABEL[type].full.toLowerCase());
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * The refusal, in the words the dispatcher needs: what is missing and what to do about it.
 *
 * Returned rather than thrown so the store and the screen can say the same thing.
 */
export function paperworkRefusal(
  load: Pick<Load, 'documents' | 'loadNumber'>,
  target: LoadStatus,
  statusLabel: string,
): string | null {
  const missing = missingDocumentsFor(load, target);
  if (missing.length === 0) return null;
  return `${load.loadNumber} cannot move to ${statusLabel.toLowerCase()} without ${describeDocuments(
    missing,
  )} on file. Attach the paperwork and try again.`;
}
