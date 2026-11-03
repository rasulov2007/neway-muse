import { PDFDocument, StandardFonts } from 'pdf-lib';
import {
  FLEET_EXPENSE_CHARGE_TO_LABEL,
  FLEET_EXPENSE_PAYER_LABEL,
  FLEET_PAYMENT_METHOD_LABEL,
  FLEET_PAYMENT_STATUS_LABEL,
  FLEET_RECOVERY_STATUS_LABEL,
  FLEET_EXPENSE_OUTCOME_LABEL,
  EFS_STATUS_LABEL,
  type FleetExpenseDetail,
  type FleetExpenseList,
} from '@neway/shared';
import { Writer } from '../hiring/dot-application-pdf';

/** The standard PDF fonts speak WinAnsi only; anything else would throw mid-document. */
function safe(text: string | null | undefined): string {
  return (text ?? '')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/→/g, '->')
    .replace(/[  ]/g, ' ')
    .replace(/[^\x20-\x7e -ÿ•]/g, '?');
}

function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '-';
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function day(iso: string | null | undefined): string {
  if (!iso) return '-';
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function stamp(at: string | null | undefined): string {
  if (!at) return '-';
  return new Date(at).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(/[  ]/g, ' ') + ' ET';
}

async function writer(title: string, footer: string): Promise<{ doc: PDFDocument; w: Writer }> {
  const doc = await PDFDocument.create();
  doc.setTitle(safe(title));
  doc.setProducer('NeWay TMS');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  return { doc, w: new Writer(doc, font, bold, safe(footer)) };
}

/**
 * One expense, as Accounting and the driver may need to see it: the place, who paid and who bears
 * it, the EFS evidence (masked: the full code never leaves the vault), the Accounting links, the
 * receipts by name and the history.
 */
export async function renderExpensePdf(e: FleetExpenseDetail, company: string, generatedAt: Date): Promise<Uint8Array> {
  const { doc, w } = await writer(`Fleet expense ${e.reference}`, `${company} · Fleet expense ${e.reference} · generated ${stamp(generatedAt.toISOString())}`);
  w.title(safe(`Fleet expense ${e.reference}`), safe(`${company} · Truck ${e.unitNumber} · ${e.categoryLabel} · ${e.status === 'void' ? 'VOID' : e.status === 'draft' ? 'Draft' : 'Recorded'}`));
  w.heading('Expense and location');
  w.field('Amount', money(e.amountCents));
  w.field('Expense date', day(e.expenseDate));
  w.field('Truck', safe(e.unitNumber));
  w.field('Category', safe(e.categoryLabel));
  w.field('Vendor / payee', safe(e.vendorName));
  w.field('Invoice #', safe(e.invoiceNumber));
  if (e.placeName) w.field('Place', safe(e.placeName));
  const address = [e.address, [e.city, e.state].filter(Boolean).join(', '), e.postalCode].filter(Boolean).join(', ');
  if (address) w.field('Address', safe(address));
  if (e.description) w.field('Description', safe(e.description));
  if (e.notes) w.field('Notes', safe(e.notes));
  w.heading('Payment and charge');
  w.field('Outcome', FLEET_EXPENSE_OUTCOME_LABEL[e.outcome]);
  w.field('Paid by', `${FLEET_EXPENSE_PAYER_LABEL[e.paidBy]}${e.payerDriverName ? ` · ${safe(e.payerDriverName)}` : e.payerName ? ` · ${safe(e.payerName)}` : ''}`);
  w.field('Payment method', e.paymentMethod ? FLEET_PAYMENT_METHOD_LABEL[e.paymentMethod] : '-');
  w.field('Payment status', FLEET_PAYMENT_STATUS_LABEL[e.paymentStatus]);
  w.field('Charge to', `${FLEET_EXPENSE_CHARGE_TO_LABEL[e.chargeTo]}${e.chargeDriverName ? ` · ${safe(e.chargeDriverName)}` : ''}`);
  if (e.chargeCents) {
    w.field('Driver charge', money(e.chargeCents));
    w.field('Charge reason', safe(e.chargeReason));
  }
  w.field('Recovery status', FLEET_RECOVERY_STATUS_LABEL[e.recoveryStatus]);
  w.field('Company cost', money(e.figures.companyCents));
  if (e.efs) {
    w.heading('EFS');
    w.field('EFS reference', safe(e.efs.masked) || '-');
    w.field('Issued', `${money(e.efs.issuedCents)} on ${day(e.efs.issuedOn)}`);
    w.field('Used', money(e.efs.usedCents));
    w.field('Unused (not spend)', money(e.efs.unusedCents));
    w.field('EFS status', EFS_STATUS_LABEL[e.efs.status]);
  }
  if (e.recovery) {
    w.heading('Driver recovery');
    w.field('Charged', money(e.recovery.chargeCents));
    w.field('Deducted', money(e.recovery.deductedCents));
    w.field('Remaining', money(e.recovery.remainingCents));
    if (e.recovery.inDraft) w.field('In draft settlement', `${safe(e.recovery.inDraft.settlementNumber)}: ${money(e.recovery.inDraft.cents)} previewed, not deducted`);
    for (const r of e.recovery.entries) w.paragraph(safe(`${r.settlementNumber ?? r.settlementId}: ${money(r.cents)} ${r.status === 'reversed' ? `deducted, then reversed${r.reason ? ` (${r.reason})` : ''}` : 'deducted'} · ${stamp(r.at)}`), { indent: 8 });
  }
  w.heading('Accounting');
  if (e.accounting.links.length === 0) w.paragraph(e.accounting.state === 'not_required' ? 'Tracked spend only: no payable and no deduction.' : e.accounting.state === 'awaiting_posting' ? 'Not posted to Accounting yet.' : '-');
  for (const l of e.accounting.links) w.paragraph(safe(`${l.label} · ${l.status}${l.amountCents !== null ? ` · ${money(l.amountCents)}` : ''}${l.at ? ` · ${stamp(l.at)}` : ''}${l.by ? ` · ${l.by}` : ''}`), { indent: 8 });
  if (e.accounting.postedAt) w.field('Posted', `${stamp(e.accounting.postedAt)} by ${safe(e.accounting.postedBy)}`);
  w.heading('Documents');
  if (e.files.length === 0) w.paragraph('No documents attached.');
  for (const f of e.files) w.paragraph(safe(`${f.fileName} (${f.kind.replace('_', ' ')}) · added ${stamp(f.addedAt)} by ${f.addedBy}`), { indent: 8 });
  w.heading('History');
  for (const h of e.history) w.paragraph(safe(`${stamp(h.at)} · ${h.by}: ${h.summary}${h.reason ? ` (${h.reason})` : ''}`), { indent: 8, size: 8.5 });
  return doc.save();
}

/** The filtered list with its totals and category breakdown, for the person who asked for it. */
export async function renderReportPdf(list: FleetExpenseList, filters: string, company: string, generatedAt: Date): Promise<Uint8Array> {
  const { doc, w } = await writer('Fleet expenses report', `${company} · Fleet expenses · generated ${stamp(generatedAt.toISOString())}`);
  w.title('Fleet expenses', safe(`${company} · ${filters}`));
  const t = list.totals;
  w.heading('Totals');
  w.field('Total fleet spend', money(t.spendCents));
  w.field('Company cost', money(t.companyCents));
  w.field('Driver charge', money(t.driverChargeCents));
  w.field('Driver charge outstanding', money(t.driverOutstandingCents));
  w.field('Paid and borne externally', money(t.externalCents));
  w.field('Unpaid vendor bills', money(t.unpaidBillsCents));
  w.field('EFS recovery remaining', money(t.efsRemainingCents));
  w.paragraph('These are separate measures: they do not add up to the total fleet spend.', { size: 8.5 });
  w.heading('By category');
  for (const c of t.byCategory) w.field(safe(c.label), `${money(c.cents)} · ${c.count} expense${c.count === 1 ? '' : 's'}`);
  w.heading(`Expenses (${list.total})`);
  if (list.rows.length === 0) w.paragraph('No expenses match these filters.');
  for (const r of list.rows) {
    const where = r.source === 'work_order' ? `${r.vendorName ?? ''} · From Maintenance` : [r.vendorName, r.placeName, [r.city, r.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ');
    w.paragraph(safe(`${day(r.expenseDate)} · ${r.reference} · Truck ${r.unitNumber} · ${r.categoryLabel} · ${money(r.amountCents)}`), { bold: true, size: 9 });
    w.paragraph(safe(`${where || '-'} · Paid by ${FLEET_EXPENSE_PAYER_LABEL[r.paidBy]} · Charge to ${FLEET_EXPENSE_CHARGE_TO_LABEL[r.chargeTo]}${r.chargeDriverName ? ` (${r.chargeDriverName})` : ''} · ${FLEET_PAYMENT_STATUS_LABEL[r.paymentStatus]} · ${FLEET_RECOVERY_STATUS_LABEL[r.recoveryStatus]}`), { indent: 8, size: 8.5 });
  }
  return doc.save();
}
