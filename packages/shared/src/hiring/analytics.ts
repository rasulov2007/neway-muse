import { z } from 'zod';
import { campaignPerformance, sumSpend } from './costs.js';
import {
  HIRING_STAGES,
  HIRING_STAGE_LABELS,
  type HiringStage,
  type HiringState,
} from './stages.js';

/**
 * Recruiting analytics: the funnel, how long each stage takes, what a hire cost, whether they
 * stayed, and how long until they were dispatched.
 *
 * Everything here is computed on read from the records the funnel already keeps — leads, cases
 * and their events, the cost ledger, campaigns, and the employees the hires became. Nothing is
 * stored. A figure that cannot be computed honestly is `null` with the reason beside it: a rate
 * with nobody eligible, a cost per hire with no hires, a days-to-first-load when dispatch has not
 * been recorded. Zero is never used to mean "not known".
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const DAY = 86_400_000;

// ------------------------------------------------------------------------------------- inputs

export interface AnalyticsLead {
  id: string;
  source: string;
  campaignId: string | null;
  status: string;
  createdAt: string;
  hiringCaseId: string | null;
}

export interface AnalyticsCaseEvent {
  toState: HiringState;
  at: string;
}

export interface AnalyticsCase {
  id: string;
  state: HiringState;
  openedAt: string;
  hiredAt: string | null;
  firstDispatchAt: string | null;
  employeeId: string | null;
  events: AnalyticsCaseEvent[];
}

export interface AnalyticsCost {
  hiringCaseId: string | null;
  leadId: string | null;
  campaignId: string | null;
  amount: number;
  incurredOn: string;
}

export interface AnalyticsCampaign {
  id: string;
  name: string;
  channel: string;
  periodStart: string;
  periodEnd: string | null;
}

/** One live dated spend entry on a campaign (voided ones are left out by the caller). */
export interface AnalyticsCampaignSpend {
  campaignId: string;
  amount: number;
  spentOn: string;
}

export interface AnalyticsEmployee {
  id: string;
  status: string;
  terminationDate: string | null;
}

export interface HiringAnalyticsInput {
  leads: readonly AnalyticsLead[];
  cases: readonly AnalyticsCase[];
  costs: readonly AnalyticsCost[];
  campaigns: readonly AnalyticsCampaign[];
  campaignSpend: readonly AnalyticsCampaignSpend[];
  employees: readonly AnalyticsEmployee[];
  /** Inclusive calendar dates. */
  period: { from: string; to: string };
  now: Date;
}

// ------------------------------------------------------------------------------------ outputs

export const FunnelRowSchema = z.object({
  key: z.string(),
  label: z.string(),
  leads: z.number().int(),
  converted: z.number().int(),
  checks: z.number().int(),
  offer: z.number().int(),
  hired: z.number().int(),
});
export type FunnelRow = z.infer<typeof FunnelRowSchema>;

/**
 * One campaign in the period. Since spend is dated (migration 0038) every money figure here is
 * the period's: the spend entries dated in it plus the campaign's own cost entries incurred in
 * it, over the leads added in it and the hires made in it. The to-date figures ride along for
 * comparison, with the same definition the Campaigns tab uses.
 */
export const CampaignFunnelRowSchema = FunnelRowSchema.extend({
  channel: z.string(),
  /** Spend entries dated in the period plus the campaign's own cost entries incurred in it. */
  spend: z.number(),
  /** Of which: the dated spend entries alone. */
  spendEntries: z.number(),
  /** Hires made in the period (hire date in it) whose lead came from this campaign. */
  hiresInPeriod: z.number().int(),
  /** Period cost over the period's leads (`leads`); null with no leads in the period. */
  costPerLead: z.number().nullable(),
  /** Period cost over the period's hires (`hiresInPeriod`); null with no hires in it. */
  costPerHire: z.number().nullable(),
  /** Campaign to date: every live spend entry plus every own cost entry, ever. */
  spendToDate: z.number(),
  /** Every lead ever attributed, and how many of them were hired. */
  leadsToDate: z.number().int(),
  hiresToDate: z.number().int(),
  /** The campaign's dates overlap the period. */
  activeInPeriod: z.boolean(),
});
export type CampaignFunnelRow = z.infer<typeof CampaignFunnelRowSchema>;

export const StageDurationSchema = z.object({
  stage: z.enum(HIRING_STAGES),
  label: z.string(),
  /** Completed stays in this stage within the period. */
  n: z.number().int(),
  medianDays: z.number().nullable(),
  meanDays: z.number().nullable(),
});
export type StageDuration = z.infer<typeof StageDurationSchema>;

export const RetentionRowSchema = z.object({
  days: z.number().int(),
  eligible: z.number().int(),
  retained: z.number().int(),
  rate: z.number().nullable(),
  reason: z.string().nullable(),
});
export type RetentionRow = z.infer<typeof RetentionRowSchema>;

export const HiringAnalyticsSchema = z.object({
  period: z.object({ from: isoDate, to: isoDate }),
  totals: z.object({
    leads: z.number().int(),
    converted: z.number().int(),
    hires: z.number().int(),
    /** Cases at Active driver whose hire happened in the period. */
    activeDrivers: z.number().int(),
  }),
  funnelBySource: z.array(FunnelRowSchema),
  funnelByCampaign: z.array(CampaignFunnelRowSchema),
  stageDurations: z.array(StageDurationSchema),
  costPerHire: z.object({
    hires: z.number().int(),
    /** Everything charged to the hires' own cases and leads. */
    directTotal: z.number(),
    directPerHire: z.number().nullable(),
    /** Every cost incurred in the period, on every lead and case, plus campaign spend. */
    trueTotal: z.number(),
    truePerHire: z.number().nullable(),
    notes: z.array(z.string()),
  }),
  retention: z.array(RetentionRowSchema),
  costPerRetainedHire90: z.object({ value: z.number().nullable(), reason: z.string().nullable() }),
  daysToFirstLoad: z.object({
    n: z.number().int(),
    meanDays: z.number().nullable(),
    reason: z.string().nullable(),
  }),
});
export type HiringAnalytics = z.infer<typeof HiringAnalyticsSchema>;

export const HiringAnalyticsQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
});

// ----------------------------------------------------------------------------- computation

/** Retention is judged at 30, 60 and 90 days after the hire (owner, 2026-10-01). */
export const RETENTION_MILESTONE_DAYS = [30, 60, 90] as const;

const REACHED: Record<'checks' | 'offer' | 'hired', readonly HiringState[]> = {
  checks: ['checks', 'safety_review', 'offer', 'ticketed', 'orientation', 'hired', 'active_driver'],
  offer: ['offer', 'ticketed', 'orientation', 'hired', 'active_driver'],
  hired: ['hired', 'active_driver'],
};

const round = (n: number, places = 2) => Math.round(n * 10 ** places) / 10 ** places;
/**
 * The business date of a value: a plain date is itself; a timestamp is read in US Eastern, the
 * one clock the product keeps (owner, 2026-09-25), so a lead added at 9 pm Eastern on the 30th
 * counts on the 30th, not on the UTC 1st.
 */
export function easternDay(iso: string): string {
  if (iso.length <= 10) return iso;
  return new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}
const day = easternDay;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number | null {
  return values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length;
}

function reached(c: AnalyticsCase, what: keyof typeof REACHED): boolean {
  const states = REACHED[what];
  return states.includes(c.state) || c.events.some((e) => states.includes(e.toState));
}

export function computeHiringAnalytics(input: HiringAnalyticsInput): HiringAnalytics {
  const { period, now } = input;
  const inPeriod = (iso: string) => day(iso) >= period.from && day(iso) <= period.to;
  const caseById = new Map(input.cases.map((c) => [c.id, c]));
  const leadByCase = new Map<string, AnalyticsLead>();
  for (const l of input.leads) if (l.hiringCaseId) leadByCase.set(l.hiringCaseId, l);

  const leads = input.leads.filter((l) => inPeriod(l.createdAt));
  const hires = input.cases.filter((c) => c.hiredAt !== null && inPeriod(c.hiredAt));

  // ---- funnel, from the leads of the period
  const funnel = (group: (l: AnalyticsLead) => string | null): Map<string, FunnelRow> => {
    const rows = new Map<string, FunnelRow>();
    for (const l of leads) {
      const key = group(l);
      if (key === null) continue;
      const row = rows.get(key) ?? {
        key,
        label: key,
        leads: 0,
        converted: 0,
        checks: 0,
        offer: 0,
        hired: 0,
      };
      row.leads += 1;
      const c = l.hiringCaseId ? caseById.get(l.hiringCaseId) : undefined;
      if (c) {
        row.converted += 1;
        if (reached(c, 'checks')) row.checks += 1;
        if (reached(c, 'offer')) row.offer += 1;
        if (reached(c, 'hired')) row.hired += 1;
      }
      rows.set(key, row);
    }
    return rows;
  };
  const funnelBySource = [...funnel((l) => l.source).values()]
    .map((r) => ({ ...r, label: r.key.replace(/_/g, ' ') }))
    .sort((a, b) => b.leads - a.leads || a.key.localeCompare(b.key));
  const byCampaign = funnel((l) => l.campaignId);
  // Spend is dated, so the period takes its own share: the spend entries dated in it plus the
  // campaign's own cost entries incurred in it, over the period's leads and the period's hires.
  const hiredCaseIds = new Set(input.cases.filter((c) => reached(c, 'hired')).map((c) => c.id));
  const hiresInPeriodIds = new Set(
    input.cases.filter((c) => c.hiredAt !== null && inPeriod(c.hiredAt)).map((c) => c.id),
  );
  const spendRows = input.campaignSpend.map((s) => ({ ...s, spentOn: day(s.spentOn) }));
  const funnelByCampaign: CampaignFunnelRow[] = input.campaigns
    .map((cmp) => {
      const r = byCampaign.get(cmp.id) ?? {
        key: cmp.id,
        label: cmp.name,
        leads: 0,
        converted: 0,
        checks: 0,
        offer: 0,
        hired: 0,
      };
      const toDate = campaignPerformance({
        campaignId: cmp.id,
        spend: sumSpend(spendRows, cmp.id),
        leads: input.leads,
        hiredCaseIds,
        costs: input.costs,
      });
      const spendEntries = sumSpend(spendRows, cmp.id, period);
      const ownCosts = input.costs
        .filter((c) => c.campaignId === cmp.id && inPeriod(c.incurredOn))
        .reduce((s, c) => s + c.amount, 0);
      const spend = round(spendEntries + ownCosts);
      const hiresInPeriod = input.leads.filter(
        (l) => l.campaignId === cmp.id && l.hiringCaseId !== null && hiresInPeriodIds.has(l.hiringCaseId),
      ).length;
      return {
        ...r,
        label: cmp.name,
        channel: cmp.channel,
        spend,
        spendEntries,
        hiresInPeriod,
        costPerLead: r.leads > 0 ? round(spend / r.leads) : null,
        costPerHire: hiresInPeriod > 0 ? round(spend / hiresInPeriod) : null,
        spendToDate: toDate.totalCost,
        leadsToDate: toDate.leadCount,
        hiresToDate: toDate.hireCount,
        activeInPeriod:
          cmp.periodStart <= period.to && (cmp.periodEnd === null || cmp.periodEnd >= period.from),
      };
    })
    .filter((r) => r.leads > 0 || r.activeInPeriod || r.spend > 0)
    .sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label));

  // ---- days in stage: every completed stay whose end fell in the period
  const stays = new Map<HiringStage, number[]>(HIRING_STAGES.map((s) => [s, []]));
  for (const c of input.cases) {
    const events = [...c.events].sort((a, b) => a.at.localeCompare(b.at));
    for (let i = 0; i < events.length - 1; i += 1) {
      const from = events[i]!;
      const to = events[i + 1]!;
      const list = stays.get(from.toState as HiringStage);
      if (!list || !inPeriod(to.at)) continue;
      list.push((Date.parse(to.at) - Date.parse(from.at)) / DAY);
    }
  }
  const stageDurations: StageDuration[] = HIRING_STAGES.map((stage) => {
    const values = stays.get(stage) ?? [];
    return {
      stage,
      label: HIRING_STAGE_LABELS[stage],
      n: values.length,
      medianDays: values.length ? round(median(values) as number, 1) : null,
      meanDays: values.length ? round(mean(values) as number, 1) : null,
    };
  });

  // ---- cost per hire
  const hireIds = new Set(hires.map((h) => h.id));
  const hireLeadIds = new Set(
    hires.map((h) => leadByCase.get(h.id)?.id).filter((v): v is string => !!v),
  );
  const directTotal = round(
    input.costs
      .filter(
        (e) =>
          (e.hiringCaseId && hireIds.has(e.hiringCaseId)) ||
          (e.leadId && hireLeadIds.has(e.leadId)),
      )
      .reduce((s, e) => s + e.amount, 0),
  );
  const periodCosts = input.costs
    .filter((e) => inPeriod(e.incurredOn))
    .reduce((s, e) => s + e.amount, 0);
  const campaignSpend = sumSpend(spendRows, null, period);
  const spendEntriesInPeriod = spendRows.filter(
    (s) => s.spentOn >= period.from && s.spentOn <= period.to,
  ).length;
  const trueTotal = round(periodCosts + campaignSpend);
  const notes: string[] = [];
  const imported = input.cases.filter(
    (c) => c.state === 'active_driver' && c.hiredAt === null,
  ).length;
  if (imported > 0) {
    notes.push(
      `${imported} driver${imported === 1 ? '' : 's'} on the roster before the funnel existed ${imported === 1 ? 'has' : 'have'} no hire event and ${imported === 1 ? 'is' : 'are'} not counted as hires.`,
    );
  }
  notes.push(
    `True cost counts every cost incurred in the period on every lead and case — including the ${input.leads.filter((l) => l.status === 'dead').length} dead leads — plus the ${spendEntriesInPeriod} campaign spend entr${spendEntriesInPeriod === 1 ? 'y' : 'ies'} dated in the period ($${campaignSpend.toFixed(2)}).`,
  );
  if (hires.length === 0)
    notes.push('No hire event fell in the period, so cost per hire cannot be computed.');

  // ---- retention, on the period's hires
  const retention: RetentionRow[] = RETENTION_MILESTONE_DAYS.map((days) => {
    const eligible = hires.filter(
      (h) => Date.parse(h.hiredAt as string) + days * DAY <= now.getTime(),
    );
    const retained = eligible.filter((h) => {
      const emp = h.employeeId ? input.employees.find((e) => e.id === h.employeeId) : undefined;
      if (!emp) return false;
      const cutoff = day(new Date(Date.parse(h.hiredAt as string) + days * DAY).toISOString());
      if (emp.terminationDate && emp.terminationDate <= cutoff) return false;
      return emp.status !== 'terminated';
    });
    return {
      days,
      eligible: eligible.length,
      retained: retained.length,
      rate: eligible.length > 0 ? round(retained.length / eligible.length, 3) : null,
      reason:
        eligible.length > 0
          ? null
          : hires.length === 0
            ? 'No hires in the period'
            : `No hire in the period is ${days} days old yet`,
    };
  });
  const r90 = retention.find((r) => r.days === 90)!;
  const eligible90 = hires.filter(
    (h) => Date.parse(h.hiredAt as string) + 90 * DAY <= now.getTime(),
  );
  const eligible90Costs = input.costs
    .filter((e) => {
      const caseId =
        e.hiringCaseId ?? input.leads.find((l) => l.id === e.leadId)?.hiringCaseId ?? null;
      return caseId !== null && eligible90.some((h) => h.id === caseId);
    })
    .reduce((s, e) => s + e.amount, 0);
  const costPerRetainedHire90 =
    r90.retained > 0
      ? { value: round(eligible90Costs / r90.retained), reason: null }
      : { value: null, reason: r90.reason ?? 'Nobody eligible at 90 days was retained' };

  // ---- days to first load
  const dispatched = hires.filter((h) => h.firstDispatchAt !== null);
  const daysToFirstLoad = {
    n: dispatched.length,
    meanDays: dispatched.length
      ? round(
          mean(
            dispatched.map(
              (h) =>
                (Date.parse(h.firstDispatchAt as string) - Date.parse(h.hiredAt as string)) / DAY,
            ),
          ) as number,
          1,
        )
      : null,
    reason: dispatched.length
      ? null
      : hires.length === 0
        ? 'No hires in the period'
        : 'First dispatch is read from the roster driver status, and no hire in the period has been dispatched yet',
  };

  return {
    period,
    totals: {
      leads: leads.length,
      converted: leads.filter((l) => l.hiringCaseId !== null).length,
      hires: hires.length,
      activeDrivers: hires.filter((h) => h.state === 'active_driver').length,
    },
    funnelBySource,
    funnelByCampaign,
    stageDurations,
    costPerHire: {
      hires: hires.length,
      directTotal,
      directPerHire: hires.length ? round(directTotal / hires.length) : null,
      trueTotal,
      truePerHire: hires.length ? round(trueTotal / hires.length) : null,
      notes,
    },
    retention,
    costPerRetainedHire90,
    daysToFirstLoad,
  };
}
