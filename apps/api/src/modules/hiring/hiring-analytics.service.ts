import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import {
  computeHiringAnalytics,
  easternDay,
  type AnalyticsCase,
  type HiringAnalytics,
  type HiringState,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import {
  hiringCampaigns,
  hiringCampaignSpend,
  hiringCases,
  hiringCostEntries,
  hiringLeads,
  hiringStageEvents,
} from '../../database/schema/hiring';
import { employees } from '../../database/schema/people';
import { CLOCK, type Clock } from '../dashboard/clock';
import { num } from '../hr/hr.util';

const DAY = 86_400_000;

/**
 * Gathers the funnel's own records and hands them to the shared computation. Nothing is stored
 * and nothing is computed here; the API's only job is the rows and the clock.
 */
@Injectable()
export class HiringAnalyticsService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get db() {
    return this.database.db;
  }

  async compute(
    principal: Principal,
    query: { from?: string; to?: string },
  ): Promise<HiringAnalytics> {
    const now = this.clock();
    // Business dates are Eastern: 'today' is the Eastern today, not the UTC one.
    const to = query.to ?? easternDay(now.toISOString());
    const from =
      query.from ?? new Date(Date.parse(`${to}T00:00:00Z`) - 90 * DAY).toISOString().slice(0, 10);
    const companyId = principal.companyId;

    const [leads, caseRows, events, costs, campaigns, spend] = await Promise.all([
      this.db
        .select()
        .from(hiringLeads)
        .where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.isTest, false))),
      this.db
        .select()
        .from(hiringCases)
        .where(and(eq(hiringCases.companyId, companyId), eq(hiringCases.isTest, false))),
      this.db
        .select({
          caseId: hiringStageEvents.caseId,
          toState: hiringStageEvents.toState,
          at: hiringStageEvents.at,
        })
        .from(hiringStageEvents)
        .where(eq(hiringStageEvents.companyId, companyId))
        .orderBy(asc(hiringStageEvents.at)),
      // A voided entry is kept for the record and counts for nothing.
      this.db
        .select()
        .from(hiringCostEntries)
        .where(and(eq(hiringCostEntries.companyId, companyId), isNull(hiringCostEntries.voidedAt))),
      this.db.select().from(hiringCampaigns).where(eq(hiringCampaigns.companyId, companyId)),
      // Dated campaign spend (0038); a voided entry counts for nothing.
      this.db
        .select({
          campaignId: hiringCampaignSpend.campaignId,
          amount: hiringCampaignSpend.amount,
          spentOn: hiringCampaignSpend.spentOn,
        })
        .from(hiringCampaignSpend)
        .where(and(eq(hiringCampaignSpend.companyId, companyId), isNull(hiringCampaignSpend.voidedAt))),
    ]);
    const employeeIds = caseRows.map((c) => c.employeeId).filter((v): v is string => !!v);
    const staff =
      employeeIds.length > 0
        ? await this.db
            .select({
              id: employees.id,
              status: employees.status,
              terminationDate: employees.terminationDate,
            })
            .from(employees)
            .where(inArray(employees.id, employeeIds))
        : [];

    const eventsByCase = new Map<string, AnalyticsCase['events']>();
    for (const e of events) {
      eventsByCase.set(e.caseId, [
        ...(eventsByCase.get(e.caseId) ?? []),
        { toState: e.toState as HiringState, at: e.at.toISOString() },
      ]);
    }

    return computeHiringAnalytics({
      leads: leads.map((l) => ({
        id: l.id,
        source: l.source,
        campaignId: l.campaignId,
        status: l.status,
        createdAt: l.createdAt.toISOString(),
        hiringCaseId: l.hiringCaseId,
      })),
      cases: caseRows.map((c) => ({
        id: c.id,
        state: c.state as HiringState,
        openedAt: c.openedAt.toISOString(),
        hiredAt: c.hiredAt?.toISOString() ?? null,
        firstDispatchAt: c.firstDispatchAt?.toISOString() ?? null,
        employeeId: c.employeeId,
        events: eventsByCase.get(c.id) ?? [],
      })),
      costs: costs.map((e) => ({
        hiringCaseId: e.hiringCaseId,
        leadId: e.leadId,
        campaignId: e.campaignId,
        amount: num(e.amount) ?? 0,
        incurredOn: e.incurredOn,
      })),
      campaigns: campaigns.map((c) => ({
        id: c.id,
        name: c.name,
        channel: c.channel,
        periodStart: c.periodStart,
        periodEnd: c.periodEnd,
      })),
      campaignSpend: spend.map((s) => ({
        campaignId: s.campaignId,
        amount: num(s.amount) ?? 0,
        spentOn: s.spentOn,
      })),
      employees: staff,
      period: { from, to },
      now,
    });
  }
}
