import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { CompanyProfileFieldsSchema } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { companies, companyProfiles, drivers } from '../../database/schema';
import { LoadsService } from '../loads/loads.service';
import { DriverAccountsService } from './driver-accounts.service';
import { ExportsService } from './exports.service';
import { stopDay, type PayReportContext, type PayReportStop } from './pay-report';
import { PayeesService } from './payees.service';
import type { StatementRecord } from './settlements.service';
import { AccountingStore } from './store.service';

/**
 * A statement's PDF, as the driver receives it: the one renderer the Accounting routes, the
 * statement emails and the driver app (mobile M3) share, so the three can never print different
 * pay reports for the same statement. It renders the stored record only - never a recomputation.
 */
@Injectable()
export class StatementPdfService {
  constructor(
    private readonly store: AccountingStore,
    private readonly accounts: DriverAccountsService,
    private readonly loads: LoadsService,
    private readonly payees: PayeesService,
    private readonly exports: ExportsService,
  ) {}

  async companyName(principal: Principal): Promise<string> {
    const [row] = await this.store.db.select({ name: companies.name }).from(companies).where(eq(companies.id, principal.companyId)).limit(1);
    return row?.name ?? 'NeWay TMS';
  }

  /** The company's letterhead for a pay report: the Company info profile, read once per request. */
  async payReportCompany(principal: Principal): Promise<PayReportContext['company']> {
    const [row] = await this.store.db.select({ record: companyProfiles.record }).from(companyProfiles).where(eq(companyProfiles.companyId, principal.companyId)).limit(1);
    const parsed = CompanyProfileFieldsSchema.safeParse(row?.record ?? {});
    if (!parsed.success) return null;
    const p = parsed.data;
    // The profile has no fax field; the report prints "Fax:" blank rather than invent one.
    return { legalName: p.legalName, address: p.physicalAddress || p.mailingAddress, phone: p.phone, fax: null };
  }

  /**
   * What a driver's pay report prints beyond the statement record: the driver's home and phone,
   * the contract type in force at the end of the period, and each load's stops. Each read is
   * optional - a load or profile this person cannot open leaves its cell blank, never the PDF.
   */
  async payReportContext(principal: Principal, s: StatementRecord, company?: PayReportContext['company']): Promise<PayReportContext> {
    if (s.partyType !== 'driver') return {};
    const [d] = await this.store.db
      .select({ phone: drivers.phone, city: drivers.homeCity, state: drivers.homeState })
      .from(drivers)
      .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, s.partyId)))
      .limit(1);
    const profile = await this.accounts.profileOn(principal, s.partyId, s.periodEnd).catch(() => null);
    const stopsByLoad: Record<string, PayReportStop[]> = {};
    const loadIds = [...new Set((s.computation?.earnings ?? []).map((e) => e.loadId).filter((id): id is string => Boolean(id)))];
    for (const id of loadIds) {
      const load = await this.loads.get(principal, id).catch(() => null);
      if (!load) continue;
      stopsByLoad[id] = [...load.stops]
        .sort((a, b) => a.sequence - b.sequence)
        .map((st) => ({ kind: st.kind, date: stopDay(st), facility: st.facilityName ?? '', city: st.city ?? '', state: st.state ?? '' }));
    }
    return {
      company: company === undefined ? await this.payReportCompany(principal) : company,
      driver: { contractType: profile?.contractType ?? null, city: d?.city ?? null, state: d?.state ?? null, phone: d?.phone ?? null },
      stopsByLoad,
    };
  }

  /** The statement's PDF bytes and file name. */
  async render(principal: Principal, s: StatementRecord): Promise<{ pdf: Buffer; fileName: string }> {
    const payee = await this.payees.forParty(principal, s.partyType, s.partyId);
    const pdf = await this.exports.statementPdf(s, await this.companyName(principal), payee ? { legalName: payee.legalName, accountLast4: payee.accountLast4 } : null, await this.payReportContext(principal, s));
    return { pdf: Buffer.from(pdf), fileName: this.exports.fileName([s.settlementNumber, s.partyName], 'pdf') };
  }
}
