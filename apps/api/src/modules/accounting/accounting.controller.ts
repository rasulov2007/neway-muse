import { Body, Controller, Get, Header, NotFoundException, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  AccountingSettingsSchema,
  ManualChargeSchema,
  RecordFundingSchema,
  RecurringDeductionSchema,
  RecurringWeekOverrideSchema,
  RecurringAmountSchema,
  LeaseWeekOverrideSchema,
  ResolveBillingExceptionSchema,
  CreateRevisionSchema,
  IssueRevisionSchema,
  InvoiceNoteSchema,
  InternalNoteSchema,
  ReviewDocumentSchema,
  CreateRtsBatchSchema,
  CancelRtsBatchSchema,
  SendRtsBatchSchema,
  RecordRtsSubmissionSchema,
  type RecordRtsSubmissionInput,
  type ReviewDocumentInput,
  UpdateDriverProfileSchema,
  settingsProblems,
  annualVendorSummary,
  SetPayDateSchema,
  LoadPayFactsSchema,
  type LoadPayFactsInput,
  type SetPayDateInput,
  AddChargeAfterInvoicingSchema,
  type AddChargeAfterInvoicingInput,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { hasPermission } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { forbidden, unprocessable } from '../dispatch-board/ops.helpers';
import { DriverAccountsService } from './driver-accounts.service';
import { ExportsService } from './exports.service';
import type { PayReportContext } from './pay-report';
import type { StatementRecord } from './settlements.service';
import { InvoicesService } from './invoices.service';
import { LedgerService } from './ledger.service';
import { ReimbursementsService } from './reimbursements.service';
import { LoadsService } from '../loads/loads.service';
import { RtsBatchesService } from './rts-batches.service';
import { PayablesService } from './payables.service';
import { PayeesService } from './payees.service';
import { PayrollService } from './payroll.service';
import { SettlementsService } from './settlements.service';
import { AccountingStore } from './store.service';
import { CompletionsService } from './completions.service';
import { ProfitabilityService } from './profitability.service';
import { EmailTransport } from './email.transport';
import { StatementEmailService } from './statement-email.service';
import { StatementPdfService } from './statement-pdf.service';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const p = <T extends z.ZodType>(schema: T) => new ZodValidationPipe(schema);

const IdsSchema = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) });
const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(500) });
const PaymentSchema = z.object({
  partyType: z.enum(['customer', 'broker']),
  partyId: z.string().min(1),
  partyName: z.string().trim().min(1),
  amount: z.number().positive(),
  method: z.enum(['ach', 'check', 'card', 'wire', 'cash']),
  receivedOn: z.string().regex(DAY),
  reference: z.string().trim().min(1).max(120),
  applications: z.array(z.object({ invoiceId: z.string().min(1), amount: z.number().positive() })),
  notes: z.string().trim().max(1000).nullable().optional(),
});
const BillSchema = z.object({ vendorId: z.string().min(1), vendorInvoiceNumber: z.string().trim().max(80).nullable(), issuedOn: z.string().regex(DAY), amount: z.number().positive(), categoryCode: z.string().min(1), truckId: z.string().nullable(), loadId: z.string().nullable(), notes: z.string().trim().max(1000).nullable(), attachments: z.array(z.object({ fileId: z.string(), fileName: z.string() })).optional() });
const BillUpdateSchema = z.object({ status: z.string().optional(), scheduledFor: z.string().regex(DAY).nullable().optional(), reason: z.string().trim().max(500).nullable().optional(), dispute: z.string().trim().max(500).nullable().optional() });
const PayBillSchema = z.object({ amount: z.number().positive(), method: z.enum(['ach', 'check', 'card', 'wire', 'cash']), paidOn: z.string().regex(DAY), reference: z.string().trim().min(1).max(120) });
const ExpenseSchema = z.object({ onDate: z.string().regex(DAY), accountingDate: z.string().regex(DAY).optional(), categoryCode: z.string().min(1), description: z.string().trim().min(1).max(200), amount: z.number().positive(), truckId: z.string().nullable(), driverId: z.string().nullable(), loadId: z.string().nullable(), vendorId: z.string().nullable(), paymentMethod: z.string().nullable(), paidDirectly: z.boolean(), notes: z.string().trim().max(1000).nullable(), burden: z.enum(['company_borne', 'recoverable_driver', 'recoverable_vendor']).optional(), receiptFileId: z.string().nullable().optional(), payer: z.enum(['company', 'driver', 'vendor']).optional() });
const AllocationsSchema = z.object({ allocations: z.array(z.object({ partyType: z.enum(['driver', 'vendor', 'truck', 'load']), partyId: z.string().min(1), amount: z.number().positive() })) });
const ImportSchema = z.object({ provider: z.enum(['relay', 'bestpass', 'efs', 'csv']), csv: z.string().min(1).max(5_000_000) });
const ResolveImportSchema = z.object({ truckId: z.string().nullable().optional(), driverId: z.string().nullable().optional(), ignore: z.boolean().optional(), reason: z.string().trim().max(300).optional() });
const TxStateSchema = z.object({ state: z.enum(['approved', 'disputed', 'paused', 'void']), reason: z.string().trim().max(500).default('') });
const NoteSchema = z.object({ body: z.string().trim().min(1).max(2000) });
const GenerateSchema = z.object({ kind: z.enum(['cd', 'lo_oo', 'vt']), weekOf: z.string().regex(DAY), includeLateLoadIds: z.array(z.string()).optional() });
const PaidSchema = z.object({ paidOn: z.string().regex(DAY), reference: z.string().trim().min(1).max(120), method: z.enum(['ach', 'check', 'wire', 'cash']), amountCents: z.number().int().min(0).optional() });
const StatusSchema = z.object({ status: z.enum(['draft', 'review']), note: z.string().trim().max(500).optional() });
/** The odometer typed in from a statement: at the start of the week, at its end, or both. */
const OdometerEntrySchema = z
  .object({ startMiles: z.number().int().min(0).max(5_000_000).nullable().optional(), endMiles: z.number().int().min(0).max(5_000_000).nullable().optional(), note: z.string().trim().max(500).nullable().optional() })
  .refine((v) => (v.startMiles ?? null) !== null || (v.endMiles ?? null) !== null, { message: 'Enter the odometer at the start of the week, at its end, or both.' });
const ArrangementSchema = z.object({ id: z.string().optional(), vendorId: z.string().min(1), truckId: z.string().min(1), effectiveFrom: z.string().regex(DAY), effectiveTo: z.string().regex(DAY).nullable(), percentBps: z.number().int().min(0).max(10_000).nullable(), note: z.string().trim().max(300).optional() });
const PayeeSchema = z.object({ partyType: z.enum(['driver', 'vendor']), partyId: z.string().min(1), legalName: z.string().trim().min(1).max(160), payeeIdentity: z.string().trim().max(160).nullable().optional(), accountType: z.enum(['checking', 'savings']).nullable().optional(), routingNumber: z.string().trim().optional(), accountNumber: z.string().trim().optional(), reason: z.string().trim().max(300).optional() });
const PrepareBatchSchema = z.object({ kind: z.enum(['driver', 'vendor']), statementIds: z.array(z.string().min(1)).min(1) });
const MarkBatchSchema = z.object({ status: z.enum(['submitted', 'accepted', 'rejected', 'paid']), externalId: z.string().trim().max(120).optional(), errors: z.array(z.string()).optional() });
// A submission status is a claim about what the provider did, so it carries how we know, and
// whether the whole thing was a rehearsal.
const SubmissionSchema = z.object({ status: z.enum(['submitted', 'accepted', 'rejected']), reference: z.string().trim().max(120).optional(), issues: z.array(z.string().trim().max(300)).optional(), evidence: z.string().trim().max(300).optional(), simulated: z.boolean().optional() });
const RcReadingSchema = z.object({ documentId: z.string().min(1), rcReference: z.string().trim().min(1).max(80), confidence: z.enum(['person', 'extracted', 'uncertain']).default('person') });
const JournalSchema = z.object({ onDate: z.string().regex(DAY), memo: z.string().trim().min(2).max(300), lines: z.array(z.object({ accountCode: z.string().min(1), debit: z.number().min(0).optional(), credit: z.number().min(0).optional(), memo: z.string().max(200).optional() })).min(2) });
const EmailSchema = z.object({ documentType: z.enum(['statement', 'invoice']), items: z.array(z.object({ documentId: z.string().min(1), recipient: z.string().trim().max(200).nullable(), label: z.string().max(200), amountCents: z.number().int() })).min(1).max(200), resend: z.boolean().optional() });
/** Statement email: the request names whether to resend - never a recipient. Any other field is refused. */
const StatementEmailSchema = z.object({ resend: z.boolean().optional() }).strict();
const PayrollGenerateSchema = z.object({ kind: z.enum(['dispatcher', 'salary']), date: z.string().regex(DAY), anchorMonday: z.string().regex(DAY).optional(), periodStart: z.string().regex(DAY).optional(), periodEnd: z.string().regex(DAY).optional(), payDate: z.string().regex(DAY).optional() });
const PayrollLineSchema = z.object({ employeeId: z.string().min(1), commissionCents: z.number().int().min(0).nullable().optional(), /** Required when a commission is set by hand instead of computed. */ reason: z.string().trim().min(2).max(300).optional(), bonusCents: z.number().int().min(0).optional(), advanceCents: z.number().int().min(0).optional(), adjustment: z.object({ description: z.string().trim().min(1).max(200), cents: z.number().int(), reason: z.string().trim().min(2).max(300) }).optional() });
const PayrollCarrySchema = z.object({ employeeId: z.string().min(1), cents: z.number().int(), reason: z.string().trim().min(2).max(300) });
const PayrollStatusSchema = z.object({ status: z.enum(['review', 'finalized', 'paid', 'closed']), paidOn: z.string().regex(DAY).optional(), reference: z.string().trim().max(120).optional(), /** Employee ids the approver has seen and accepts as left out (no pay plan). */ acknowledgeExcluded: z.array(z.string()).optional() });
// `settings` is taken as given (a partial); the merge with what is on file is what gets validated. Parsing the
// partial through the schema would fill every absent key with its default and silently reset the rest.
const SettingsSchema = z.object({ expectedVersion: z.number().int().min(0), settings: z.record(z.string(), z.unknown()), dispatcherPeriodAnchor: z.string().regex(DAY).nullable().optional(), /** Setting key to the reason it is being confirmed; recorded with who and when. */ confirmations: z.record(z.string(), z.string().trim().min(2).max(300)).optional() });

/**
 * Accounting (§1–§12). Reads need accounting.view - driver statements, settlements and accounts
 * included (owner, 2026-10-25); writes need accounting.edit; bank details and payment batches need
 * accounting.bank. Every route runs under the company scope guard: nothing crosses a company.
 */
@Controller('accounting')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class AccountingController {
  constructor(
    private readonly store: AccountingStore,
    private readonly ledger: LedgerService,
    private readonly invoices: InvoicesService,
    private readonly payables: PayablesService,
    private readonly reimbursements: ReimbursementsService,
    private readonly accounts: DriverAccountsService,
    private readonly settlements: SettlementsService,
    private readonly payroll: PayrollService,
    private readonly payees: PayeesService,
    private readonly exports: ExportsService,
    private readonly completions: CompletionsService,
    private readonly profitability: ProfitabilityService,
    private readonly mail: EmailTransport,
    private readonly loads: LoadsService,
    private readonly rts: RtsBatchesService,
    private readonly statementEmail: StatementEmailService,
    private readonly pdfs: StatementPdfService,
  ) {}

  // The pay report a statement prints is rendered by StatementPdfService, shared with the statement
  // emails and the driver app (mobile M3), so the three never print different reports.
  private companyName(principal: Principal): Promise<string> {
    return this.pdfs.companyName(principal);
  }

  private payReportContext(principal: Principal, s: StatementRecord, company?: PayReportContext['company']): Promise<PayReportContext> {
    return this.pdfs.payReportContext(principal, s, company);
  }

  private payReportCompany(principal: Principal): Promise<PayReportContext['company']> {
    return this.pdfs.payReportCompany(principal);
  }

  private send(reply: FastifyReply, file: Buffer | string, type: string, name: string) {
    return reply.header('content-type', type).header('content-disposition', `attachment; filename="${name}"`).header('cache-control', 'private, no-store').send(file);
  }

  // ------------------------------------------------------------ settings and ledger

  @Get('settings')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  async settings(@CurrentPrincipal() principal: Principal) {
    const raw = await this.store.settings(principal.companyId);
    const settings = AccountingSettingsSchema.parse(raw.record);
    const mail = this.mail.describe();
    // Categories, kept honest: csv_import (a file the person exports from the portal), export
    // (a file we produce, format not certified by the receiver), sandbox (tested against a
    // stand-in), live (credentials on file and verified), not_configured.
    return {
      version: raw.version,
      settings,
      problems: settingsProblems(settings),
      // Who decided each unresolved business value, and when. A number with nobody's name on it
      // is a guess as far as anyone reading a finalized period afterwards can tell.
      confirmations: (raw.record['confirmations'] as Record<string, { at: string; by: string; note: string }> | undefined) ?? {},
      /** Every save of these settings, newest first: what changed, who changed it and when. */
      history: ((raw.record['settingsHistory'] as Array<{ at: string; by: string; changed: string[] }> | undefined) ?? []).slice(0, 20),
      dispatcherPeriodAnchor: (raw.record['dispatcherPeriodAnchor'] as string | null) ?? null,
      // Every clock in the product is US Eastern (owner, 2026-09-25); the pay week reads it too.
      timezone: { value: settings.payPeriodTimezone, source: 'US Eastern (every clock in the product)', note: 'Nobody has confirmed it as the settlement clock in these settings yet.' },
      integrations: {
        rts: { state: 'export', detail: 'Invoices prepared here; sent to RTS over FTPS (one way) once the RTS account passes Test, or exported and uploaded by hand. RTS sends nothing back: funding is recorded by hand.' },
        relay: { state: 'csv_import', detail: 'Portal CSV import with dedupe; no API credentials on file.' },
        bestpass: { state: 'csv_import', detail: 'Portal CSV import with dedupe; no API credentials on file.' },
        efs: { state: 'csv_import', detail: 'Portal CSV import with dedupe; driver-charge lines go to review; no API credentials on file.' },
        breakthrough_fuel: { state: 'not_configured', detail: 'No credentials, no adapter.' },
        quickbooks: { state: 'not_configured', detail: 'Not connected; ownership of postings undecided.' },
        adp: { state: 'export', detail: 'Generic bank CSV from an approved batch. Not an ADP-certified format; ADP not connected.' },
        email: { state: mail.kind === 'smtp' ? 'live' : mail.kind === 'file' ? 'sandbox' : 'not_configured', detail: mail.detail },
      },
    };
  }

  /**
   * Saves some settings without disturbing the rest.
   *
   * The merge is done on what is stored and validated as a whole, rather than re-parsing the
   * stored record first: parsing it first would fill every key the current schema knows about
   * with its default, so a value that no longer validates would be silently replaced by a
   * default instead of being reported. Anything stored that the schema has no opinion about is
   * carried through untouched.
   *
   * `confirmations` is how an unresolved business value stops being unresolved: the caller names
   * the keys they are confirming and why, and the decision is kept with their name and the time.
   * Nothing here chooses a value on the owner's behalf.
   */
  @Put('settings')
  @RequirePermission('accounting.edit')
  async saveSettings(@CurrentPrincipal() principal: Principal, @Body(p(SettingsSchema)) body: z.infer<typeof SettingsSchema>) {
    const raw = await this.store.settings(principal.companyId);
    const candidate = { ...raw.record, ...body.settings };
    const parsed = AccountingSettingsSchema.safeParse(candidate);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw unprocessable(`${first?.path.join('.') ?? 'A setting'} is not a value this setting accepts: ${first?.message ?? 'invalid'}. Nothing was saved.`);
    }
    const merged = parsed.data;
    const now = this.clockNow();
    const by = principal.userName ?? principal.userId;
    const changed = Object.keys(body.settings ?? {}).filter((key) => JSON.stringify((raw.record as Record<string, unknown>)[key]) !== JSON.stringify((candidate as Record<string, unknown>)[key]));

    const confirmations = { ...((raw.record['confirmations'] as Record<string, { at: string; by: string; note: string }> | undefined) ?? {}) };
    for (const [key, note] of Object.entries(body.confirmations ?? {})) {
      confirmations[key] = { at: now, by, note };
    }
    const history = [{ at: now, by, changed: changed.length > 0 ? changed : Object.keys(body.confirmations ?? {}).map((k) => `confirmed:${k}`) }, ...((raw.record['settingsHistory'] as Array<{ at: string; by: string; changed: string[] }> | undefined) ?? [])].slice(0, 50);

    const record = {
      ...raw.record,
      ...merged,
      confirmations,
      settingsHistory: history,
      ...(body.dispatcherPeriodAnchor !== undefined ? { dispatcherPeriodAnchor: body.dispatcherPeriodAnchor } : {}),
    };
    const saved = await this.store.saveSettings(principal.companyId, body.expectedVersion, record, by);
    return { version: saved.version, settings: merged, problems: settingsProblems(merged), confirmations, history: history.slice(0, 20) };
  }

  /** The server clock, so a confirmation is stamped by the server and not by a browser. */
  private clockNow(): string {
    return new Date().toISOString();
  }

  @Get('ledger')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  async journal(@CurrentPrincipal() principal: Principal) {
    const [journal, periods] = await Promise.all([this.ledger.journal(principal.companyId), this.ledger.periods(principal.companyId)]);
    return { journal, periods };
  }

  @Post('ledger/entries')
  @RequirePermission('accounting.edit')
  postEntry(@CurrentPrincipal() principal: Principal, @Body(p(JournalSchema)) body: z.infer<typeof JournalSchema>) {
    return this.ledger.postAdjustment(principal, body);
  }

  @Post('ledger/entries/:id/reverse')
  @RequirePermission('accounting.edit')
  reverse(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.ledger.reverse(principal, id, body.reason);
  }

  @Post('ledger/periods/:id/close')
  @RequirePermission('accounting.edit')
  closePeriod(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.ledger.closePeriod(principal, id);
  }

  @Post('ledger/periods/:id/reopen')
  @RequirePermission('accounting.edit')
  reopenPeriod(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.ledger.reopenPeriod(principal, id, body.reason);
  }

  @Get('export/ledger.csv')
  @RequirePermission('accounting.view')
  async ledgerCsv(@CurrentPrincipal() principal: Principal, @Res() reply: FastifyReply) {
    const journal = await this.ledger.journal(principal.companyId);
    const rows = [['Entry', 'Date', 'Source', 'Memo', 'Account', 'Debit', 'Credit'], ...journal.flatMap((e) => e.lines.map((l) => [e.id, e.onDate, e.source, e.memo, l.accountCode, l.debit / 100, l.credit / 100]))];
    return this.send(reply, this.exports.csv(rows), 'text/csv; charset=utf-8', this.exports.fileName(['ledger', new Date().toISOString().slice(0, 10)], 'csv'));
  }

  // ------------------------------------------------------------ billing and invoices

  @Get('billing/queue')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  queue(@CurrentPrincipal() principal: Principal) {
    return this.invoices.queue(principal);
  }

  @Get('invoices')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  invoiceList(@CurrentPrincipal() principal: Principal) {
    return this.invoices.list(principal);
  }

  /**
   * The invoice list for a date range as Excel or PDF (owner, 2026-10-23). By the invoice date;
   * a draft has none, so it comes only with no range. Voided invoices are left out unless asked.
   */
  @Get('invoices-export/:format')
  @RequirePermission('accounting.view')
  async invoicesExport(
    @CurrentPrincipal() principal: Principal,
    @Param('format') format: string,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('customer') customer: string | undefined,
    @Query('status') status: string | undefined,
    @Res() reply: FastifyReply,
  ) {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !day.test(from)) || (to && !day.test(to))) throw unprocessable('Dates are YYYY-MM-DD.');
    const rows = (await this.invoices.list(principal))
      .filter((i) => i.isCurrent)
      .filter((i) => (status ? i.status === status : i.status !== 'void'))
      .filter((i) => !customer || i.billToId === customer)
      .filter((i) => (!from && !to) || (i.issuedOn !== null && (!from || i.issuedOn >= from) && (!to || i.issuedOn <= to)))
      .sort((a, b) => (a.issuedOn ?? '').localeCompare(b.issuedOn ?? '') || a.invoiceNumber.localeCompare(b.invoiceNumber));
    if (rows.length === 0) throw unprocessable('No invoices in that period.');
    const period = from || to ? `${from ?? 'start'} to ${to ?? 'today'}` : 'All dates';
    const name = ['invoices', from ?? 'all', to ?? ''];
    if (format === 'xlsx') return this.send(reply, this.exports.xlsx('Invoices', this.exports.invoicesRows(rows)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', this.exports.fileName(name, 'xlsx'));
    if (format === 'pdf') return this.send(reply, await this.exports.invoicesPdf(rows, await this.companyName(principal), period), 'application/pdf', this.exports.fileName(name, 'pdf'));
    throw unprocessable('Format is xlsx or pdf.');
  }

  @Get('receivables')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  receivables(@CurrentPrincipal() principal: Principal) {
    return this.invoices.receivables(principal);
  }

  @Get('payments')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  payments(@CurrentPrincipal() principal: Principal) {
    return this.invoices.payments(principal);
  }

  @Get('invoices/:id')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  invoice(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.invoices.get(principal, id);
  }

  @Get('invoices/:id/pdf')
  @RequirePermission('accounting.view')
  async invoicePdf(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    const inv = await this.invoices.get(principal, id);
    const pdf = await this.invoices.pdfBytes(principal, inv);
    return this.send(reply, pdf, 'application/pdf', this.exports.fileName([inv.invoiceNumber], 'pdf'));
  }

  @Post('invoices/from-loads')
  @RequirePermission('accounting.edit')
  createFromLoads(@CurrentPrincipal() principal: Principal, @Body(p(IdsSchema)) body: z.infer<typeof IdsSchema>) {
    return this.invoices.createFromLoads(principal, body.ids);
  }

  @Post('invoices/:id/issue')
  @RequirePermission('accounting.edit')
  issue(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.invoices.issue(principal, id);
  }

  @Post('invoices/:id/void')
  @RequirePermission('accounting.edit')
  async voidInvoice(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    const out = await this.invoices.void(principal, id, body.reason);
    // A voided supplemental invoice's charges were dropped from the load: driver pay follows.
    if (out.ok && out.invoice.supplementOf) {
      for (const l of out.invoice.lines) if (l.loadChargeId) await this.settlements.syncLateAccessorial(principal, out.invoice.loadId, l.loadChargeId);
    }
    return out;
  }

  // ------------------------------------------------------------ revisions and notes
  //
  // A revision is drafted (nothing posts), then issued (only the difference posts). Every route
  // here needs accounting.edit on the server, whatever the screen shows.

  @Post('invoices/:id/revise')
  @RequirePermission('accounting.edit')
  revise(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(CreateRevisionSchema)) body: z.infer<typeof CreateRevisionSchema>) {
    return this.invoices.revise(principal, id, body);
  }

  @Post('invoices/:id/issue-revision')
  @RequirePermission('accounting.edit')
  issueRevision(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(IssueRevisionSchema)) body: z.infer<typeof IssueRevisionSchema>) {
    return this.invoices.issueRevision(principal, id, body);
  }

  @Post('invoices/:id/discard-revision')
  @RequirePermission('accounting.edit')
  discardRevision(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.invoices.discardRevision(principal, id, body.reason);
  }

  @Get('invoices/:id/family')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  invoiceFamily(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.invoices.family(principal, id);
  }

  @Get('invoices/:id/revision-options')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  revisionOptions(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.invoices.revisionOptions(principal, id);
  }

  // ------------------------------------------------------------ charges after invoicing
  //
  // A layover, detention or lumper that comes in after the invoice went to RTS is billed on a
  // supplemental invoice (INV-10004-S1); the original is never changed (owner, 2026-10-21).

  @Get('invoices/:id/supplements')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  async supplements(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    const [check, supplements] = await Promise.all([this.invoices.supplementCheck(principal, id), this.invoices.supplementsOf(principal, id)]);
    return { check, supplements };
  }

  @Post('invoices/:id/supplements')
  @RequirePermission('accounting.edit')
  async addChargeAfterInvoicing(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(AddChargeAfterInvoicingSchema)) body: AddChargeAfterInvoicingInput) {
    const out = await this.invoices.addChargeAfterInvoicing(principal, id, body);
    if (!out.ok) return out;
    // The driver's side: each charge's "Include in driver statement?" answer, from the dialog. Paid
    // through the normal load pay rules; a load already settled pays it on the next statement.
    const load = await this.loads.get(principal, out.invoice.loadId).catch(() => null);
    const drivers = load ? [load.driverId, ((load as Record<string, unknown>)['coDriverId'] as string | null | undefined) ?? null].filter((d): d is string => Boolean(d)) : [];
    const driverPay: Array<{ chargeId: string; treatment: string }> = [];
    if (!out.existing && drivers.length > 0) {
      for (const [i, c] of body.charges.entries()) {
        const chargeId = out.invoice.lines[i]?.loadChargeId;
        if (!chargeId) continue;
        const pay = c.payableToDriver ? (c.driverPay ?? { mode: 'full' as const, value: 100 }) : null;
        await this.settlements.allocateAccessorial(principal, out.invoice.loadId, {
          chargeId,
          treatment: pay ? 'paid_separately' : 'excluded',
          mode: pay?.mode ?? 'full',
          value: pay?.value ?? 100,
          nature: 'earning',
          recipients: drivers,
        });
        driverPay.push({ chargeId, treatment: pay ? 'paid_separately' : 'excluded' });
      }
    }
    return { ...out, driverPay };
  }

  @Post('invoices/:id/note')
  @RequirePermission('accounting.edit')
  invoiceNote(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(InvoiceNoteSchema)) body: z.infer<typeof InvoiceNoteSchema>) {
    return this.invoices.setInvoiceNote(principal, id, body);
  }

  @Post('invoices/:id/internal-notes')
  @RequirePermission('accounting.edit')
  addInternalNote(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(InternalNoteSchema)) body: z.infer<typeof InternalNoteSchema>) {
    return this.invoices.addInternalNote(principal, id, body.text);
  }

  @Post('invoices/:id/internal-notes/:noteId')
  @RequirePermission('accounting.edit')
  editInternalNote(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Param('noteId') noteId: string, @Body(p(InternalNoteSchema)) body: z.infer<typeof InternalNoteSchema>) {
    return this.invoices.editInternalNote(principal, id, noteId, body.text);
  }

  // ------------------------------------------------------------ RTS export batches
  //
  // Issued invoices gathered into a package for RTS. RTS is not connected: the package is
  // exported as files and uploaded by a person, and the submission is recorded separately.

  @Get('rts/candidates')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  rtsCandidates(@CurrentPrincipal() principal: Principal) {
    return this.rts.candidates(principal);
  }

  @Get('rts/batches')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  rtsBatches(@CurrentPrincipal() principal: Principal) {
    return this.rts.batches(principal);
  }

  @Get('rts/batches/:id')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  async rtsBatch(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    const { record, version } = await this.rts.batch(principal, id);
    return { ...record, version };
  }

  @Post('rts/batches')
  @RequirePermission('accounting.edit')
  createRtsBatch(@CurrentPrincipal() principal: Principal, @Body(p(CreateRtsBatchSchema)) body: z.infer<typeof CreateRtsBatchSchema>) {
    return this.rts.create(principal, body.invoiceIds);
  }

  /** Downloads the package. POST, because producing it is recorded; it sends nothing anywhere. */
  @Post('rts/batches/:id/export')
  @RequirePermission('accounting.edit')
  async exportRtsBatch(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    const { fileName, data } = await this.rts.exportPackage(principal, id);
    await reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${fileName}"`).header('cache-control', 'private, no-store').send(data);
  }

  /**
   * The exact files the FTPS upload sends - one `<invoice#>.pdf` per invoice and the RTS CSV - as a
   * ZIP, for a test upload by hand. Sends nothing.
   */
  @Post('rts/batches/:id/ftp-export')
  @RequirePermission('accounting.edit')
  async exportRtsFtpFiles(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    const { fileName, data } = await this.rts.exportFtpFiles(principal, id);
    await reply.header('content-type', 'application/zip').header('content-disposition', `attachment; filename="${fileName}"`).header('cache-control', 'private, no-store').send(data);
  }

  /** Three TEST invoice packets and their CSV to RTS's test folder; creates no record (2026-10-20). */
  @Post('rts/test-packets')
  @RequirePermission('accounting.edit')
  sendRtsTestPackets(@CurrentPrincipal() principal: Principal) {
    return this.rts.sendTestPackets(principal);
  }

  /** Uploads the batch to RTS over FTPS - PDFs first, the CSV last - and records it submitted. */
  @Post('rts/batches/:id/send')
  @RequirePermission('accounting.edit')
  sendRtsBatch(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(SendRtsBatchSchema)) body: z.infer<typeof SendRtsBatchSchema>) {
    return this.rts.sendFtp(principal, id, body.expectedVersion);
  }

  @Post('rts/batches/:id/cancel')
  @RequirePermission('accounting.edit')
  cancelRtsBatch(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(CancelRtsBatchSchema)) body: z.infer<typeof CancelRtsBatchSchema>) {
    return this.rts.cancel(principal, id, body);
  }

  @Post('rts/batches/:id/submission')
  @RequirePermission('accounting.edit')
  recordRtsSubmission(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(RecordRtsSubmissionSchema)) body: RecordRtsSubmissionInput) {
    return this.rts.recordSubmission(principal, id, body);
  }

  @Post('invoices/:id/submission')
  @RequirePermission('accounting.edit')
  submission(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(SubmissionSchema)) body: z.infer<typeof SubmissionSchema>) {
    return this.invoices.markSubmission(principal, id, body);
  }

  @Post('invoices/:id/dispute')
  @RequirePermission('accounting.edit')
  dispute(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.invoices.dispute(principal, id, body.reason);
  }

  @Post('payments')
  @RequirePermission('accounting.edit')
  recordPayment(@CurrentPrincipal() principal: Principal, @Body(p(PaymentSchema)) body: z.infer<typeof PaymentSchema>) {
    return this.invoices.recordPayment(principal, body);
  }

  @Post('fundings')
  @RequirePermission('accounting.edit')
  recordFunding(@CurrentPrincipal() principal: Principal, @Body(p(RecordFundingSchema)) body: z.infer<typeof RecordFundingSchema>) {
    return this.invoices.recordFunding(principal, body);
  }

  @Get('billing/loads/:loadId/exceptions')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  exceptions(@CurrentPrincipal() principal: Principal, @Param('loadId') loadId: string) {
    return this.invoices.exceptionsFor(principal, loadId);
  }

  @Post('billing/loads/:loadId/rc-reading')
  @RequirePermission('accounting.edit')
  rcReading(@CurrentPrincipal() principal: Principal, @Param('loadId') loadId: string, @Body(p(RcReadingSchema)) body: z.infer<typeof RcReadingSchema>) {
    return this.invoices.recordRcReading(principal, loadId, body);
  }

  /**
   * Accounting's review of one file on a load: Mark reviewed, or Reject with a reason.
   *
   * Billing is where RC, BOL and POD are checked, and Accounting may not hold the dispatch board's
   * loads.edit - so the review is offered here, under accounting.edit, and runs the very same write
   * rule the load's own route does: the version check, the per-file refusals, the timeline event
   * and the audit entry. It sets the document's review and nothing else; the RC reference and
   * duplicate checks are separate conditions it cannot clear.
   */
  @Post('billing/loads/:loadId/documents/:documentId/review')
  @RequirePermission('accounting.edit')
  reviewBillingDocument(@CurrentPrincipal() principal: Principal, @Param('loadId') loadId: string, @Param('documentId') documentId: string, @Body(p(ReviewDocumentSchema)) body: ReviewDocumentInput) {
    return this.loads.reviewDocument(principal, loadId, documentId, body);
  }

  @Post('billing/loads/:loadId/resolve')
  @RequirePermission('accounting.edit')
  resolve(@CurrentPrincipal() principal: Principal, @Param('loadId') loadId: string, @Body(p(ResolveBillingExceptionSchema)) body: z.infer<typeof ResolveBillingExceptionSchema>) {
    return this.invoices.resolveException(principal, loadId, body);
  }

  @Post('billing/loads/:loadId/rc-replaced')
  @RequirePermission('accounting.edit')
  rcReplaced(@CurrentPrincipal() principal: Principal, @Param('loadId') loadId: string) {
    return this.invoices.invalidateRcResolutions(principal, loadId).then((n) => ({ superseded: n }));
  }

  @Post('billing/loads/:loadId/accessorials')
  @RequirePermission('accounting.edit')
  allocateAccessorial(@CurrentPrincipal() principal: Principal, @Param('loadId') loadId: string, @Body() body: unknown) {
    return this.settlements.allocateAccessorial(principal, loadId, body);
  }

  // ------------------------------------------------------------ vendors, bills, expenses, imports

  @Get('vendors')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  vendors(@CurrentPrincipal() principal: Principal) {
    return this.payables.vendors(principal);
  }

  @Get('bills')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  bills(@CurrentPrincipal() principal: Principal) {
    return this.payables.bills(principal);
  }

  @Post('bills')
  @RequirePermission('accounting.edit')
  createBill(@CurrentPrincipal() principal: Principal, @Body(p(BillSchema)) body: z.infer<typeof BillSchema>) {
    return this.payables.createBill(principal, body);
  }

  @Get('bills/work-order-candidates')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  workOrderCandidates(@CurrentPrincipal() principal: Principal) {
    return this.payables.workOrderBillCandidates(principal);
  }

  @Post('bills/from-work-orders')
  @RequirePermission('accounting.edit')
  billsFromWorkOrders(@CurrentPrincipal() principal: Principal, @Body(p(IdsSchema)) body: z.infer<typeof IdsSchema>) {
    return this.payables.createBillsFromWorkOrders(principal, body.ids);
  }

  @Post('bills/:id')
  @RequirePermission('accounting.edit')
  updateBill(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(BillUpdateSchema)) body: z.infer<typeof BillUpdateSchema>) {
    return this.payables.updateBill(principal, id, body as never);
  }

  @Post('bills/:id/pay')
  @RequirePermission('accounting.edit')
  payBill(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(PayBillSchema)) body: z.infer<typeof PayBillSchema>) {
    return this.payables.payBill(principal, id, body);
  }

  @Get('expenses')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  expenses(@CurrentPrincipal() principal: Principal) {
    return this.payables.expenses(principal);
  }

  @Post('expenses')
  @RequirePermission('accounting.edit')
  createExpense(@CurrentPrincipal() principal: Principal, @Body(p(ExpenseSchema)) body: z.infer<typeof ExpenseSchema>) {
    return this.payables.createExpense(principal, body);
  }

  /** A reversing entry beside the original; the expense is kept, marked void, never deleted. */
  @Post('expenses/:id/void')
  @RequirePermission('accounting.edit')
  voidExpense(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.payables.voidExpense(principal, id, body.reason);
  }

  // ------------------------------------------------------------ reimbursements
  //
  // A reimbursement is an expense with a review block, so these routes sit beside the expense
  // ones and read the same table. Accounting reviews; everyone else with accounting.view reads.

  @Get('reimbursements')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  listReimbursements(
    @CurrentPrincipal() principal: Principal,
    @Query('status') status?: string,
    @Query('driverId') driverId?: string,
    @Query('truckId') truckId?: string,
    @Query('category') category?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.reimbursements.list(principal, { status: status as never, driverId, truckId, category, from, to });
  }

  @Get('reimbursements/summary')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  reimbursementSummary(@CurrentPrincipal() principal: Principal) {
    return this.reimbursements.summary(principal);
  }

  /** Loads a reimbursement can be filed against; declared before `:id` so it is not read as one. */
  @Get('reimbursements/load-options')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  reimbursementLoadOptions(@CurrentPrincipal() principal: Principal, @Query('q') q?: string, @Query('driverId') driverId?: string) {
    return this.reimbursements.loadOptions(principal, { q, driverId });
  }

  @Get('reimbursements/:id')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  reimbursement(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.reimbursements.get(principal, id);
  }

  @Post('reimbursements')
  @RequirePermission('accounting.edit')
  createReimbursement(@CurrentPrincipal() principal: Principal, @Body() body: unknown) {
    return this.reimbursements.create(principal, body);
  }

  @Post('reimbursements/:id/review')
  @RequirePermission('accounting.edit')
  reviewReimbursement(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body() body: unknown) {
    return this.reimbursements.review(principal, id, body);
  }

  @Post('expenses/:id/allocations')
  @RequirePermission('accounting.edit')
  allocateExpense(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(AllocationsSchema)) body: z.infer<typeof AllocationsSchema>) {
    return this.payables.allocateExpense(principal, id, body.allocations);
  }

  @Get('imports')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  imports(@CurrentPrincipal() principal: Principal, @Query('state') state?: string) {
    return this.payables.imports(principal, state);
  }

  @Post('imports/csv')
  @RequirePermission('accounting.edit')
  importCsv(@CurrentPrincipal() principal: Principal, @Body(p(ImportSchema)) body: z.infer<typeof ImportSchema>) {
    return this.payables.importCsv(principal, body.provider, body.csv);
  }

  /** The same parse and match, written nowhere: what the file would import, what is already on file. */
  @Post('imports/csv/preview')
  @RequirePermission('accounting.edit')
  importCsvPreview(@CurrentPrincipal() principal: Principal, @Body(p(ImportSchema)) body: z.infer<typeof ImportSchema>) {
    return this.payables.importCsv(principal, body.provider, body.csv, { dryRun: true });
  }

  @Post('imports/:id/resolve')
  @RequirePermission('accounting.edit')
  resolveImport(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(ResolveImportSchema)) body: z.infer<typeof ResolveImportSchema>) {
    return this.payables.resolveImport(principal, id, body);
  }

  @Post('imports/post')
  @RequirePermission('accounting.edit')
  postImports(@CurrentPrincipal() principal: Principal, @Body(p(IdsSchema)) body: z.infer<typeof IdsSchema>) {
    return this.payables.postImports(principal, body.ids);
  }

  // ------------------------------------------------------------ driver financial accounts

  /** Driver statements, settlements and accounts: Accounting only (owner, 2026-10-25; drivers.view no longer opens them). */
  private viewer(principal: Principal): void {
    if (!hasPermission(principal, 'accounting.view')) throw forbidden('Driver statements and accounts are for Accounting only.');
  }

  @RequirePermission('accounting.view')
  @Get('drivers/:driverId/account')
  @Header('Cache-Control', 'private, no-store')
  driverAccount(@CurrentPrincipal() principal: Principal, @Param('driverId') driverId: string) {
    this.viewer(principal);
    return this.accounts.overview(principal, driverId);
  }

  @Put('drivers/:driverId/profile')
  @RequirePermission('accounting.edit')
  driverProfile(@CurrentPrincipal() principal: Principal, @Param('driverId') driverId: string, @Body(p(UpdateDriverProfileSchema)) body: z.infer<typeof UpdateDriverProfileSchema>) {
    return this.accounts.updateProfile(principal, driverId, body);
  }

  @Post('drivers/:driverId/charges')
  @RequirePermission('accounting.edit')
  manualCharge(@CurrentPrincipal() principal: Principal, @Param('driverId') driverId: string, @Body(p(ManualChargeSchema)) body: z.infer<typeof ManualChargeSchema>) {
    return this.accounts.manualCharge(principal, driverId, body);
  }

  @Post('drivers/:driverId/notes')
  @RequirePermission('accounting.edit')
  driverNote(@CurrentPrincipal() principal: Principal, @Param('driverId') driverId: string, @Body(p(NoteSchema)) body: z.infer<typeof NoteSchema>) {
    return this.accounts.addNote(principal, driverId, body.body);
  }

  @Post('drivers/:driverId/recurring')
  @RequirePermission('accounting.edit')
  recurring(@CurrentPrincipal() principal: Principal, @Param('driverId') driverId: string, @Body(p(RecurringDeductionSchema.extend({ id: z.string().optional(), expectedVersion: z.number().int().optional() }))) body: z.infer<typeof RecurringDeductionSchema> & { id?: string; expectedVersion?: number }) {
    return this.accounts.saveRecurring(principal, driverId, body);
  }

  @Post('driver-transactions/:id/state')
  @RequirePermission('accounting.edit')
  txState(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(TxStateSchema)) body: z.infer<typeof TxStateSchema>) {
    return this.accounts.setTransactionState(principal, id, body.state, body.reason);
  }

  // ------------------------------------------------------------ settlements

  @Get('settlements/batches')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  batches(@CurrentPrincipal() principal: Principal) {
    return this.settlements.batches(principal);
  }

  @Get('settlements/preview')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  settlementPreview(@CurrentPrincipal() principal: Principal, @Query('kind') kind?: string, @Query('weekOf') weekOf?: string) {
    const k = kind === 'lo_oo' || kind === 'vt' ? kind : 'cd';
    const today = new Date().toISOString().slice(0, 10);
    return this.settlements.preview(principal, { kind: k, weekOf: weekOf && DAY.test(weekOf) ? weekOf : today });
  }

  @Post('drivers/:driverId/recurring/:id/week')
  @RequirePermission('accounting.edit')
  recurringWeek(@CurrentPrincipal() principal: Principal, @Param('driverId') driverId: string, @Param('id') id: string, @Body(p(RecurringWeekOverrideSchema)) body: z.infer<typeof RecurringWeekOverrideSchema>) {
    return this.accounts.recurringWeek(principal, driverId, id, body);
  }

  @Post('drivers/:driverId/recurring/:id/amount')
  @RequirePermission('accounting.edit')
  recurringAmount(@CurrentPrincipal() principal: Principal, @Param('driverId') driverId: string, @Param('id') id: string, @Body(p(RecurringAmountSchema)) body: z.infer<typeof RecurringAmountSchema>) {
    return this.accounts.recurringAmount(principal, driverId, id, body);
  }

  @Post('drivers/:driverId/recurring/:id/stop')
  @RequirePermission('accounting.edit')
  stopRecurring(@CurrentPrincipal() principal: Principal, @Param('driverId') driverId: string, @Param('id') id: string, @Body(p(z.object({ reason: z.string().trim().min(3, 'Say why (at least 3 characters)').max(300) }))) body: { reason: string }) {
    return this.accounts.stopRecurring(principal, driverId, id, body.reason);
  }

  @Post('drivers/:driverId/lease-week')
  @RequirePermission('accounting.edit')
  leaseWeek(@CurrentPrincipal() principal: Principal, @Param('driverId') driverId: string, @Body(p(LeaseWeekOverrideSchema)) body: z.infer<typeof LeaseWeekOverrideSchema>) {
    return this.accounts.leaseWeek(principal, driverId, body);
  }

  @Get('recurring')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  recurringAll(@CurrentPrincipal() principal: Principal) {
    return this.accounts.recurringAll(principal);
  }

  @Get('drivers/review')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  driverReview(@CurrentPrincipal() principal: Principal) {
    return this.accounts.review(principal);
  }

  @Get('settlements')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  statements(@CurrentPrincipal() principal: Principal, @Query('batchId') batchId?: string, @Query('partyId') partyId?: string, @Query('kind') kind?: string) {
    return this.settlements.freshStatements(principal, { batchId, partyId, kind });
  }

  @Get('settlements/arrangements')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  arrangements(@CurrentPrincipal() principal: Principal) {
    return this.settlements.arrangements(principal);
  }

  @Post('settlements/arrangements')
  @RequirePermission('accounting.edit')
  saveArrangement(@CurrentPrincipal() principal: Principal, @Body(p(ArrangementSchema)) body: z.infer<typeof ArrangementSchema>) {
    return this.settlements.saveArrangement(principal, body);
  }

  @Get('settlements/vendors/:vendorId/annual')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  async annual(@CurrentPrincipal() principal: Principal, @Param('vendorId') vendorId: string, @Query('year') year?: string) {
    const y = Number(year) || new Date().getUTCFullYear();
    const rows = await this.settlements.statements(principal, { partyId: vendorId, kind: 'vt' });
    return annualVendorSummary(rows.map((s) => ({ periodStart: s.periodStart, status: s.status, totalEarningsCents: s.vendor?.totalEarningsCents ?? 0, totalDeductionsCents: s.vendor?.totalDeductionsCents ?? 0, vendorAdjustmentsCents: s.vendor?.vendorAdjustmentsCents ?? 0, payoutCents: s.netCents, paidCents: s.paidCents })), y);
  }

  @Post('settlements/generate')
  @RequirePermission('accounting.edit')
  generate(@CurrentPrincipal() principal: Principal, @Body(p(GenerateSchema)) body: z.infer<typeof GenerateSchema>) {
    return this.settlements.generate(principal, body);
  }

  @Post('settlements/batches/:id/close')
  @RequirePermission('accounting.edit')
  closeBatch(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.settlements.closeBatch(principal, id);
  }

  @RequirePermission('accounting.view')
  @Get('settlements/:id')
  @Header('Cache-Control', 'private, no-store')
  async statement(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    this.viewer(principal);
    const s = await this.settlements.statement(principal, id);
    if (!hasPermission(principal, 'accounting.view') && s.partyType !== 'driver') throw forbidden('Vendor statements need accounting.view.');
    return s;
  }

  @Post('settlements/:id/approve')
  @RequirePermission('accounting.edit')
  approve(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.settlements.approve(principal, id);
  }

  /** An approved statement is opened for editing again, until its payment is posted (owner, 2026-10-21). */
  @Post('settlements/:id/reopen')
  @RequirePermission('accounting.edit')
  reopenStatement(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.settlements.reopen(principal, id, body.reason);
  }

  @Post('settlements/:id/paid')
  @RequirePermission('accounting.edit')
  paid(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(PaidSchema)) body: z.infer<typeof PaidSchema>) {
    return this.settlements.markPaid(principal, id, body);
  }

  /** The truck's odometer at both ends of the week, typed in when the ELD has none (owner, 2026-10-21). */
  @Post('settlements/:id/odometer')
  @RequirePermission('accounting.edit')
  statementOdometer(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(OdometerEntrySchema)) body: z.infer<typeof OdometerEntrySchema>) {
    return this.settlements.enterOdometer(principal, id, body);
  }

  /** Takes a load off a draft statement; it is listed there to be put back, and otherwise goes on the next statement (owner, 2026-10-21). */
  @Post('settlements/:id/loads/:loadId/remove')
  @RequirePermission('accounting.edit')
  removeStatementLoad(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Param('loadId') loadId: string, @Body(p(ReasonSchema)) body: z.infer<typeof ReasonSchema>) {
    return this.settlements.removeLoad(principal, id, loadId, body.reason);
  }

  /** Puts a load taken off this statement back on it, in one click (owner, 2026-10-21). */
  @Post('settlements/:id/loads/:loadId/put-back')
  @RequirePermission('accounting.edit')
  putBackStatementLoad(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Param('loadId') loadId: string) {
    return this.settlements.putBackLoad(principal, id, loadId);
  }

  /** Real vs For driver and the REF number, corrected on a draft statement (owner, 2026-10-23). */
  @Post('settlements/:id/loads/:loadId/pay-facts')
  @RequirePermission('accounting.edit')
  setStatementLoadPayFacts(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Param('loadId') loadId: string, @Body(p(LoadPayFactsSchema)) body: LoadPayFactsInput) {
    return this.settlements.setLoadPayFacts(principal, id, loadId, body);
  }

  /** When a load counts for driver pay, and which statements list it. */
  @Get('loads/:loadId/pay')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  loadPay(@CurrentPrincipal() principal: Principal, @Param('loadId') loadId: string) {
    return this.settlements.loadPay(principal, loadId);
  }

  /** "Counts for pay on": Accounting's pay-date override for one load, with a reason (owner, 2026-10-21). */
  @Post('loads/:loadId/pay-date')
  @RequirePermission('accounting.edit')
  setLoadPayDate(@CurrentPrincipal() principal: Principal, @Param('loadId') loadId: string, @Body(p(SetPayDateSchema)) body: SetPayDateInput) {
    return this.settlements.setLoadPayDate(principal, loadId, body);
  }

  @Post('settlements/:id/status')
  @RequirePermission('accounting.edit')
  statementStatus(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(StatusSchema)) body: z.infer<typeof StatusSchema>) {
    return this.settlements.setStatus(principal, id, body.status, body.note);
  }

  @RequirePermission('accounting.view')
  @Get('settlements/:id/pdf')
  async statementPdf(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    this.viewer(principal);
    const s = await this.settlements.statement(principal, id);
    const payee = await this.payees.forParty(principal, s.partyType, s.partyId);
    const pdf = await this.exports.statementPdf(s, await this.companyName(principal), payee ? { legalName: payee.legalName, accountLast4: payee.accountLast4 } : null, await this.payReportContext(principal, s));
    return this.send(reply, pdf, 'application/pdf', this.exports.fileName([s.settlementNumber, s.partyName], 'pdf'));
  }

  @Get('settlements/export/:format')
  @RequirePermission('accounting.view')
  async statementsExport(@CurrentPrincipal() principal: Principal, @Param('format') format: string, @Query('ids') ids: string | undefined, @Query('batchId') batchId: string | undefined, @Res() reply: FastifyReply) {
    const wanted = ids ? ids.split(',').filter(Boolean) : null;
    const all = await this.settlements.freshStatements(principal, batchId ? { batchId } : undefined);
    const rows = wanted ? all.filter((s) => wanted.includes(s.id)) : all;
    if (rows.length === 0) throw unprocessable('Nothing to export.');
    const stamp = new Date().toISOString().slice(0, 10);
    if (format === 'csv') return this.send(reply, this.exports.csv(this.exports.statementsRows(rows)), 'text/csv; charset=utf-8', this.exports.fileName(['statements', stamp], 'csv'));
    if (format === 'xlsx') return this.send(reply, this.exports.xlsx('Statements', this.exports.statementsRows(rows)), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', this.exports.fileName(['statements', stamp], 'xlsx'));
    if (format === 'zip') {
      const company = await this.companyName(principal);
      const letterhead = await this.payReportCompany(principal);
      const files = [];
      for (const s of rows) {
        const payee = await this.payees.forParty(principal, s.partyType, s.partyId);
        files.push({ name: this.exports.fileName([s.settlementNumber, s.partyName], 'pdf'), data: await this.exports.statementPdf(s, company, payee ? { legalName: payee.legalName, accountLast4: payee.accountLast4 } : null, await this.payReportContext(principal, s, letterhead)) });
      }
      return this.send(reply, this.exports.zipPdfs(files), 'application/zip', this.exports.fileName(['statements', stamp], 'zip'));
    }
    throw unprocessable('Format is csv, xlsx or zip.');
  }

  @Get('completions')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  completionsList(@CurrentPrincipal() principal: Principal) {
    return this.completions.list(principal);
  }

  @Get('completions/backfill')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  backfillDryRun(@CurrentPrincipal() principal: Principal) {
    return this.completions.backfill(principal, false);
  }

  @Get('completions/:loadId')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  async completionForLoad(@CurrentPrincipal() principal: Principal, @Param('loadId') loadId: string) {
    const rec = await this.completions.forLoad(principal, loadId);
    if (!rec) throw new NotFoundException('No completion record for that load: it has not completed, or the backfill has not run.');
    return rec;
  }

  @Post('completions/backfill')
  @RequirePermission('accounting.edit')
  backfillApply(@CurrentPrincipal() principal: Principal) {
    return this.completions.backfill(principal, true);
  }

  @Post('completions/:loadId/retry')
  @RequirePermission('accounting.edit')
  completionRetry(@CurrentPrincipal() principal: Principal, @Param('loadId') loadId: string) {
    return this.completions.retry(principal, loadId);
  }

  @Get('legacy/escrow')
  @RequirePermission('accounting.edit')
  @Header('Cache-Control', 'private, no-store')
  legacyEscrowDryRun(@CurrentPrincipal() principal: Principal) {
    return this.accounts.importLegacyEscrow(principal, false);
  }

  @Post('legacy/escrow/import')
  @RequirePermission('accounting.edit')
  legacyEscrowImport(@CurrentPrincipal() principal: Principal) {
    return this.accounts.importLegacyEscrow(principal, true);
  }

  @Get('profitability')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  profitabilityReport(@CurrentPrincipal() principal: Principal, @Query('from') from?: string, @Query('to') to?: string) {
    const today = new Date().toISOString().slice(0, 10);
    return this.profitability.report(principal, { from: from && DAY.test(from) ? from : `${today.slice(0, 7)}-01`, to: to && DAY.test(to) ? to : today });
  }

  @Post('deliveries/:id/retry')
  @RequirePermission('accounting.edit')
  retryDelivery(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.exports.retryDelivery(principal, id, (type, documentId) => this.renderFor(principal, type, documentId));
  }

  @Post('deliveries/email')
  @RequirePermission('accounting.edit')
  email(@CurrentPrincipal() principal: Principal, @Body(p(EmailSchema)) body: z.infer<typeof EmailSchema>) {
    return this.exports.email(principal, { ...body, render: (documentId) => this.renderFor(principal, body.documentType, documentId) });
  }

  /** The PDF a delivery carries: the statement or invoice as the recipient should see it. */
  private async renderFor(principal: Principal, type: string, documentId: string): Promise<{ pdf: Buffer; fileName: string; subject: string } | null> {
    const company = await this.companyName(principal);
    if (type === 'statement') return this.renderStatement(principal, await this.settlements.statement(principal, documentId), company);
    const inv = await this.invoices.get(principal, documentId);
    return { pdf: await this.invoices.pdfBytes(principal, inv), fileName: this.exports.fileName([inv.invoiceNumber], 'pdf'), subject: `${company} · Invoice ${inv.invoiceNumber}` };
  }

  /** One statement's PDF, rendered from that record only (statement emails and deliveries). */
  private async renderStatement(principal: Principal, s: StatementRecord, company?: string): Promise<{ pdf: Buffer; fileName: string; subject: string }> {
    const name = company ?? (await this.companyName(principal));
    const payee = await this.payees.forParty(principal, s.partyType, s.partyId);
    return { pdf: await this.exports.statementPdf(s, name, payee ? { legalName: payee.legalName, accountLast4: payee.accountLast4 } : null, await this.payReportContext(principal, s)), fileName: this.exports.fileName([s.settlementNumber, s.partyName], 'pdf'), subject: `${name} · Statement ${s.settlementNumber} · ${s.periodStart} to ${s.periodEnd}` };
  }

  // ------------------------------------------------------------ driver statement emails (brief 2026-10-27 §7.4)

  /** The last email of each statement of a week (or of the ids given), with the bounced flag. */
  @Get('settlements/email-status')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  statementEmailStatus(@CurrentPrincipal() principal: Principal, @Query('batchId') batchId?: string, @Query('ids') ids?: string) {
    return this.statementEmail.statesFor(principal, { batchId: batchId || undefined, ids: ids ? ids.split(',').filter(Boolean).slice(0, 500) : undefined });
  }

  /** What "Send all by email" would do for the week: who gets one, who is skipped. Writes nothing. */
  @Get('settlements/batches/:id/email')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  statementEmailPreview(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Query('resend') resend?: string) {
    return this.statementEmail.preview(principal, id, resend === 'true');
  }

  /** "Send all by email": every approved driver statement of the week, one email each, on the server. */
  @Post('settlements/batches/:id/email')
  @RequirePermission('accounting.edit')
  statementEmailBatch(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(StatementEmailSchema)) body: z.infer<typeof StatementEmailSchema>) {
    return this.statementEmail.sendBatch(principal, id, (s) => this.renderStatement(principal, s), body.resend === true);
  }

  /** "Send by email" for one statement, to the address on that statement's own driver record. */
  @Post('settlements/:id/email')
  @RequirePermission('accounting.edit')
  statementEmailOne(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(StatementEmailSchema)) body: z.infer<typeof StatementEmailSchema>) {
    return this.statementEmail.sendOne(principal, id, (s) => this.renderStatement(principal, s), body.resend === true);
  }

  @Get('deliveries')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  deliveries(@CurrentPrincipal() principal: Principal, @Query('documentType') documentType?: string, @Query('documentId') documentId?: string) {
    return this.exports.deliveries(principal, documentType, documentId);
  }

  // ------------------------------------------------------------ payees and payment batches

  @Get('payees')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  payeeList(@CurrentPrincipal() principal: Principal) {
    return this.payees.list(principal);
  }

  @Put('payees')
  @RequirePermission('accounting.bank')
  savePayee(@CurrentPrincipal() principal: Principal, @Body(p(PayeeSchema)) body: z.infer<typeof PayeeSchema>) {
    return this.payees.save(principal, body);
  }

  @Post('payees/:id/verify')
  @RequirePermission('accounting.bank')
  verifyPayee(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.payees.verify(principal, id);
  }

  @Get('payment-batches')
  @RequirePermission('accounting.view')
  @Header('Cache-Control', 'private, no-store')
  paymentBatches(@CurrentPrincipal() principal: Principal) {
    return this.payees.batches(principal);
  }

  @Post('payment-batches')
  @RequirePermission('accounting.edit')
  prepareBatch(@CurrentPrincipal() principal: Principal, @Body(p(PrepareBatchSchema)) body: z.infer<typeof PrepareBatchSchema>) {
    return this.payees.prepare(principal, body);
  }

  @Post('payment-batches/:id/approve')
  @RequirePermission('accounting.bank')
  approveBatch(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.payees.approveBatch(principal, id);
  }

  @Get('payment-batches/:id/export.csv')
  @RequirePermission('accounting.bank')
  async exportBatch(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Res() reply: FastifyReply) {
    const { csv } = await this.payees.exportBatch(principal, id);
    return this.send(reply, csv, 'text/csv; charset=utf-8', this.exports.fileName(['payment_batch', id], 'csv'));
  }

  @Post('payment-batches/:id/mark')
  @RequirePermission('accounting.bank')
  markBatch(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(MarkBatchSchema)) body: z.infer<typeof MarkBatchSchema>) {
    return this.payees.markBatch(principal, id, body);
  }

  // ------------------------------------------------------------ payroll

  @Get('payroll/staff')
  @RequirePermission('payroll.view')
  @Header('Cache-Control', 'private, no-store')
  staff(@CurrentPrincipal() principal: Principal) {
    return this.payroll.staff(principal);
  }

  @Post('payroll/staff/:employeeId/plans')
  @RequirePermission('accounting.edit')
  savePlan(@CurrentPrincipal() principal: Principal, @Param('employeeId') employeeId: string, @Body() body: unknown) {
    const raw = (body ?? {}) as { confirmRate?: boolean; reason?: string };
    return this.payroll.savePlan(principal, employeeId, body, { confirmRate: raw.confirmRate === true, reason: raw.reason });
  }

  @Get('payroll/periods')
  @RequirePermission('payroll.view')
  @Header('Cache-Control', 'private, no-store')
  payrollPeriods(@CurrentPrincipal() principal: Principal) {
    return this.payroll.periods(principal);
  }

  @Post('payroll/periods/generate')
  @RequirePermission('accounting.edit')
  payrollGenerate(@CurrentPrincipal() principal: Principal, @Body(p(PayrollGenerateSchema)) body: z.infer<typeof PayrollGenerateSchema>) {
    return this.payroll.generate(principal, body);
  }

  @Post('payroll/periods/:id/lines')
  @RequirePermission('accounting.edit')
  payrollLine(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(PayrollLineSchema)) body: z.infer<typeof PayrollLineSchema>) {
    return this.payroll.setLine(principal, id, body.employeeId, body);
  }

  /** What a finalized period would compute to now: read-only, so history is not rewritten. */
  @Get('payroll/periods/:id/recheck')
  @RequirePermission('payroll.view')
  @Header('Cache-Control', 'private, no-store')
  payrollRecheck(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.payroll.recheck(principal, id);
  }

  /** Carries a difference from a finalized period into the next open one, with its reason. */
  @Post('payroll/periods/:id/carry-adjustment')
  @RequirePermission('accounting.edit')
  payrollCarry(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(PayrollCarrySchema)) body: z.infer<typeof PayrollCarrySchema>) {
    return this.payroll.carryAdjustment(principal, id, body);
  }

  @Post('payroll/periods/:id/status')
  @RequirePermission('accounting.edit')
  payrollStatus(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(p(PayrollStatusSchema)) body: z.infer<typeof PayrollStatusSchema>) {
    return this.payroll.setStatus(principal, id, body.status, body);
  }
}
