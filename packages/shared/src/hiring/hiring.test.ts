import { describe, expect, it } from 'vitest';
import { SETTING_DEFAULTS, SETTING_SCHEMAS } from '../admin/settings.js';
import { DRIVER_ONBOARDING_TEMPLATES, onboardingGate } from '../hr/onboarding-templates.js';
import {
  computeHiringAnalytics,
  easternDay,
  type AnalyticsCase,
  type HiringAnalyticsInput,
} from './analytics.js';
import {
  COST_CATEGORIES,
  COST_CATEGORY_OF_TYPE,
  COST_TYPES,
  COST_TYPE_BY_REQUIREMENT,
  CreateCampaignSchema,
  CreateCostEntrySchema,
  DEFAULT_UNIT_COSTS,
  UNIT_COST_SETTING_KEYS,
  campaignPerformance,
  costPostsToAccounting,
  sumCosts,
  sumSpend,
  UpdateCampaignSchema,
} from './costs.js';
import {
  DEFAULT_PREQUALIFICATION_RULES,
  PREQUAL_SETTING_KEYS,
  PrequalificationSchema,
  prequalify,
  type Prequalification,
} from './leads.js';
import {
  DotApplicationFormSchema,
  DotApplicationSchema,
  SaveDotApplicationSchema,
  checkDotApplication,
  employersToVerify,
  type DotApplicationForm,
  type EmployerEntry,
  type EmploymentEntry,
} from './dot-application.js';
import {
  HIRING_END_REASONS,
  HIRING_STATES,
  HIRING_STAGE_LABELS,
  hiringStageFromVerification,
  isTerminal,
  type HiringState,
} from './stages.js';

const clean: Prequalification = {
  age23Plus: true,
  cdlHeldYears: 5,
  otrExperienceYears: 4,
  accidents36mo: 0,
  movingViolations36mo: 1,
  duiEver: false,
  endorsements: ['H'],
  payTypePreference: 'company',
  homeState: 'TX',
  earliestStartDate: null,
};

describe('prequalify', () => {
  it('passes a clean record under the default rules', () => {
    expect(prequalify(clean, DEFAULT_PREQUALIFICATION_RULES)).toEqual({
      qualifies: true,
      failed: [],
    });
  });

  it('names every rule that failed, not just the first', () => {
    const result = prequalify(
      { ...clean, age23Plus: false, accidents36mo: 3, duiEver: true },
      DEFAULT_PREQUALIFICATION_RULES,
    );
    expect(result.qualifies).toBe(false);
    expect(result.failed.map((f) => f.rule)).toEqual([
      PREQUAL_SETTING_KEYS.requireAge23,
      PREQUAL_SETTING_KEYS.maxAccidents36mo,
      PREQUAL_SETTING_KEYS.duiDisqualifies,
    ]);
    // The detail carries the number answered against the number allowed.
    expect(result.failed[1]?.detail).toBe('3 accidents in 36 months; at most 2');
  });

  it('treats an empty threshold as the rule being switched off, not as zero', () => {
    const result = prequalify(
      { ...clean, accidents36mo: 9 },
      { ...DEFAULT_PREQUALIFICATION_RULES, maxAccidents36mo: null },
    );
    expect(result.qualifies).toBe(true);
  });

  it('is exact at the boundary: at most two accidents means two passes', () => {
    expect(
      prequalify({ ...clean, accidents36mo: 2 }, DEFAULT_PREQUALIFICATION_RULES).qualifies,
    ).toBe(true);
    expect(
      prequalify({ ...clean, cdlHeldYears: 2 }, DEFAULT_PREQUALIFICATION_RULES).qualifies,
    ).toBe(true);
    expect(
      prequalify({ ...clean, cdlHeldYears: 1.5 }, DEFAULT_PREQUALIFICATION_RULES).qualifies,
    ).toBe(false);
  });

  it('stores the fact the rule needs rather than the date of birth', () => {
    const parsed = PrequalificationSchema.safeParse({ ...clean, dateOfBirth: '1990-01-01' });
    expect(parsed.success).toBe(true);
    expect(parsed.success && 'dateOfBirth' in parsed.data).toBe(false);
  });

  it('only accepts the pay types the company actually has', () => {
    const parsed = PrequalificationSchema.safeParse({ ...clean, payTypePreference: 'C-30' });
    expect(parsed.success).toBe(false);
  });
});

describe('hiring stages', () => {
  it('has a label for every state and a reason for every end', () => {
    for (const state of HIRING_STATES) expect(HIRING_STAGE_LABELS[state]).toBeTruthy();
    expect(HIRING_END_REASONS).toContain('other');
  });

  it('maps a rejected decision to disqualified and an approved one to offer, or to active driver', () => {
    expect(hiringStageFromVerification('decision', 'rejected')).toBe('disqualified');
    expect(hiringStageFromVerification('active', 'approved')).toBe('offer');
    expect(hiringStageFromVerification('active', 'approved', { driverIsActive: true })).toBe(
      'active_driver',
    );
    expect(hiringStageFromVerification('consent', null)).toBe('checks');
    expect(isTerminal('disqualified')).toBe(true);
    expect(isTerminal('checks')).toBe(false);
  });
});

describe('DOT application', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');
  const employer = (
    employer: string,
    from: string,
    to: string | null,
    flags: Partial<Pick<EmployerEntry, 'droveCmv' | 'dotRegulated' | 'subjectToDrugTesting'>> = {},
  ): EmploymentEntry => ({
    kind: 'employer',
    employer,
    address: null,
    phone: null,
    contactName: null,
    position: 'Driver',
    from,
    to,
    reasonForLeaving: null,
    droveCmv: true,
    dotRegulated: true,
    subjectToDrugTesting: true,
    ...flags,
  });
  const complete: DotApplicationForm = DotApplicationFormSchema.parse({
    legalFirstName: 'Test',
    legalMiddleName: null,
    legalLastName: 'Applicant',
    dateOfBirth: '1988-04-12',
    addresses: [
      {
        street: '1 Main St',
        city: 'Dallas',
        state: 'tx',
        zip: '75201',
        from: '2019-01-01',
        to: null,
      },
    ],
    licenses: [
      {
        state: 'TX',
        number: '12345678',
        licenseClass: 'A',
        endorsements: ['H'],
        expiresOn: '2028-01-01',
      },
    ],
    employment: [
      employer('Acme Freight', '2021-03-01', null),
      employer('Blue Line Logistics', '2015-06-01', '2021-02-15'),
    ],
    accidents: [],
    convictions: [],
    licenseDeniedOrRevoked: false,
    licenseDeniedOrRevokedDetail: null,
    certifiedName: 'Test Applicant',
    certifiedOn: '2026-09-05',
  });

  it('accepts a complete application and upper-cases the state', () => {
    expect(checkDotApplication(complete, now)).toEqual([]);
    expect(complete.addresses[0]?.state).toBe('TX');
  });

  it('names every section a draft still needs', () => {
    const draft: DotApplicationForm = {
      ...complete,
      addresses: [],
      licenses: [],
      employment: [],
      certifiedName: null,
      certifiedOn: null,
    };
    const sections = checkDotApplication(draft, now).map((i) => i.section);
    expect(sections).toEqual(['addresses', 'licenses', 'employment', 'certification']);
  });

  it('finds the gap in three years of addresses, to the day', () => {
    const issues = checkDotApplication(
      {
        ...complete,
        addresses: [
          {
            street: '2 Elm',
            city: 'Austin',
            state: 'TX',
            zip: '78701',
            from: '2024-06-01',
            to: null,
          },
          {
            street: '1 Main St',
            city: 'Dallas',
            state: 'TX',
            zip: '75201',
            from: '2019-01-01',
            to: '2024-03-01',
          },
        ],
      },
      now,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]?.detail).toBe(
      'Addresses do not cover 2024-03-01 to 2024-06-01; the last 3 years must be accounted for',
    );
  });

  it('accepts an employment gap that is explained and rejects one that is not', () => {
    const unexplained = checkDotApplication(
      {
        ...complete,
        employment: [
          employer('Acme Freight', '2024-06-01', null),
          employer('Blue Line Logistics', '2015-06-01', '2024-02-15'),
        ],
      },
      now,
    );
    expect(unexplained.map((i) => i.detail)).toEqual([
      'Employment is not accounted for from 2024-02-15 to 2024-06-01; add the employer or explain the gap',
    ]);
    const explained = checkDotApplication(
      {
        ...complete,
        employment: [
          employer('Acme Freight', '2024-06-01', null),
          { kind: 'gap', from: '2024-02-15', to: '2024-06-01', explanation: 'Caring for a parent' },
          employer('Blue Line Logistics', '2015-06-01', '2024-02-15'),
        ],
      },
      now,
    );
    expect(explained).toEqual([]);
    // A break of under a month needs no explanation, and one before the three-year window is
    // not asked about.
    const tolerated = checkDotApplication(
      {
        ...complete,
        employment: [
          employer('Acme Freight', '2024-03-10', null),
          employer('Blue Line Logistics', '2015-06-01', '2024-02-15'),
        ],
      },
      now,
    );
    expect(tolerated).toEqual([]);
  });

  it('asks for ten years of commercial driving history, but only once the applicant has driven a CMV', () => {
    const shortCmv = checkDotApplication(
      { ...complete, employment: [employer('Acme Freight', '2021-03-01', null)] },
      now,
    );
    expect(shortCmv.map((i) => i.detail)).toEqual([
      'Commercial driving history goes back 10 years; account for 2016-09-06 to 2021-03-01 with earlier employers, non-driving work or an explained gap',
    ]);
    const office = checkDotApplication(
      {
        ...complete,
        employment: [
          employer('Acme Freight', '2021-03-01', null, { droveCmv: false, dotRegulated: false }),
        ],
      },
      now,
    );
    expect(office).toEqual([]);
  });

  it('keeps incidents inside their three-year window and requires the licence-action detail', () => {
    const issues = checkDotApplication(
      {
        ...complete,
        accidents: [
          {
            date: '2022-01-01',
            location: 'I-35',
            nature: 'Rear-ended',
            fatalities: 0,
            injuries: 0,
            hazmatSpill: false,
          },
        ],
        licenseDeniedOrRevoked: true,
        licenseDeniedOrRevokedDetail: null,
      },
      now,
    );
    expect(issues.map((i) => i.detail)).toEqual([
      'Accident on 2022-01-01 is outside the 3-year window',
      'Say which licence was denied, revoked or suspended, and why',
    ]);
  });

  it('owes a verification to each DOT-regulated employer of the last three years, most recent first', () => {
    const owed = employersToVerify(
      {
        ...complete,
        employment: [
          employer('Blue Line Logistics', '2015-06-01', '2021-02-15'),
          employer('Corner Store', '2022-01-01', '2022-06-01', {
            droveCmv: false,
            dotRegulated: false,
          }),
          employer('Acme Freight', '2022-06-01', '2024-01-01'),
          employer('Delta Haul', '2024-01-01', null),
        ],
      },
      now,
    );
    expect(owed.map((e) => e.employer)).toEqual(['Delta Haul', 'Acme Freight']);
  });

  it('never returns the social security number: the input carries it, the record carries four digits', () => {
    expect(SaveDotApplicationSchema.parse({ ...complete, ssn: '123-45-6789' }).ssn).toBe(
      '123-45-6789',
    );
    expect(() => SaveDotApplicationSchema.parse({ ...complete, ssn: '12-345' })).toThrow();
    expect(Object.keys(DotApplicationSchema.shape)).not.toContain('ssn');
    expect(Object.keys(DotApplicationSchema.shape)).toContain('ssnLast4');
  });
});

describe('cost ledger', () => {
  it('sums on read, by type and in total, to the cent', () => {
    const summary = sumCosts([
      { type: 'mvr', amount: 18 },
      { type: 'psp', amount: 10 },
      { type: 'clearinghouse', amount: 1.25 },
      { type: 'travel', amount: 145.1 },
      { type: 'travel', amount: 0.2 },
    ]);
    expect(summary.total).toBe(174.55);
    expect(summary.byType.travel).toBe(145.3);
    expect(summary.entries).toBe(5);
    expect(sumCosts([])).toEqual({ total: 0, byType: {}, entries: 0 });
  });

  it('prices the four screening reports from settings keys with the brief’s defaults', () => {
    expect(COST_TYPE_BY_REQUIREMENT).toEqual({
      mvr_review: 'mvr',
      psp_review: 'psp',
      clearinghouse_query: 'clearinghouse',
      pre_employment_drug_test: 'drug_test',
    });
    expect(DEFAULT_UNIT_COSTS).toEqual({ mvr: 18, psp: 10, clearinghouse: 1.25, drug_test: 65 });
    for (const key of Object.values(UNIT_COST_SETTING_KEYS)) {
      expect(SETTING_SCHEMAS[key], key).toBeDefined();
      expect(SETTING_DEFAULTS[key], key).toBe(
        DEFAULT_UNIT_COSTS[key.split('.').pop() as keyof typeof DEFAULT_UNIT_COSTS],
      );
    }
  });

  it('a cost is against a case or a lead, never floating', () => {
    expect(() =>
      CreateCostEntrySchema.parse({ type: 'other', amount: 5, incurredOn: '2026-09-01' }),
    ).toThrow();
    expect(
      CreateCostEntrySchema.parse({
        leadId: 'lead_1',
        type: 'other',
        amount: 5,
        incurredOn: '2026-09-01',
      }).leadId,
    ).toBe('lead_1');
  });

  it('leaves a voided entry out of every total but keeps counting the live ones', () => {
    const summary = sumCosts([
      { type: 'travel', amount: 120 },
      { type: 'travel', amount: 999, voidedAt: '2026-09-02T10:00:00.000Z' },
      { type: 'other', amount: 5, voidedAt: null },
    ]);
    expect(summary).toEqual({ total: 125, byType: { travel: 120, other: 5 }, entries: 2 });
  });

  it('refuses a $0 manual cost but lets an Accounting expense supply the amount', () => {
    expect(
      CreateCostEntrySchema.safeParse({ hiringCaseId: 'hc', type: 'travel', amount: 0, incurredOn: '2026-09-01' })
        .success,
    ).toBe(false);
    expect(
      CreateCostEntrySchema.safeParse({
        hiringCaseId: 'hc',
        type: 'travel',
        amount: 0,
        incurredOn: '2026-09-01',
        accountingExpenseId: 'exp_1',
      }).success,
    ).toBe(true);
  });

  it('files every cost type under exactly one of the five categories', () => {
    for (const type of COST_TYPES) expect(COST_CATEGORIES).toContain(COST_CATEGORY_OF_TYPE[type]);
  });

  it('prices a campaign to date: spend plus its own entries over its leads and hires', () => {
    const p = campaignPerformance({
      campaignId: 'c1',
      spend: 300,
      leads: [
        { campaignId: 'c1', hiringCaseId: 'hc1' },
        { campaignId: 'c1', hiringCaseId: null },
        { campaignId: 'c1', hiringCaseId: 'hc2' },
        { campaignId: 'c2', hiringCaseId: 'hc3' },
      ],
      hiredCaseIds: new Set(['hc1', 'hc3']),
      costs: [
        { campaignId: 'c1', amount: 30 },
        { campaignId: null, amount: 1000 },
      ],
    });
    expect(p).toEqual({
      leadCount: 3,
      candidateCount: 2,
      hireCount: 1,
      acquisitionCost: 30,
      totalCost: 330,
      costPerLead: 110,
      costPerHire: 330,
    });
    const none = campaignPerformance({ campaignId: 'c9', spend: 50, leads: [], hiredCaseIds: new Set(), costs: [] });
    // Unknown is not zero: no leads means no cost per lead at all.
    expect(none.costPerLead).toBeNull();
    expect(none.costPerHire).toBeNull();
  });

  it('refuses a campaign that ends before it starts, on the end-date field', () => {
    const r = CreateCampaignSchema.safeParse({
      name: 'Radio',
      channel: 'radio',
      periodStart: '2026-09-10',
      periodEnd: '2026-09-01',
    });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['periodEnd']);
  });

  it('keeps spend out of a campaign edit: spend is the dated entries', () => {
    const r = UpdateCampaignSchema.parse({ spend: 900, name: 'Renamed' });
    expect(r).toEqual({ name: 'Renamed' });
  });

  it('posts entered costs and real automatic spend to Accounting, never a screening estimate', () => {
    expect(costPostsToAccounting({ source: 'manual', type: 'mvr' })).toBe(true);
    expect(costPostsToAccounting({ source: 'auto', type: 'travel' })).toBe(true);
    expect(costPostsToAccounting({ source: 'auto', type: 'orientation_pay' })).toBe(true);
    expect(costPostsToAccounting({ source: 'auto', type: 'sign_on_bonus' })).toBe(true);
    expect(costPostsToAccounting({ source: 'auto', type: 'mvr' })).toBe(false);
    expect(costPostsToAccounting({ source: 'auto', type: 'drug_test' })).toBe(false);
  });
});

describe('hiring analytics', () => {
  const now = new Date('2026-09-06T12:00:00.000Z');
  const period = { from: '2026-06-01', to: '2026-09-06' };
  const events = (...steps: [string, string][]) =>
    steps.map(([toState, at]) => ({ toState: toState as HiringState, at }));
  const hiredCase: AnalyticsCase = {
    id: 'hc_1',
    state: 'hired',
    openedAt: '2026-07-01T00:00:00.000Z',
    hiredAt: '2026-07-20T00:00:00.000Z',
    firstDispatchAt: '2026-07-24T00:00:00.000Z',
    employeeId: 'emp_1',
    events: events(
      ['lead', '2026-06-20T00:00:00.000Z'],
      ['application', '2026-07-01T00:00:00.000Z'],
      ['checks', '2026-07-03T00:00:00.000Z'],
      ['offer', '2026-07-10T00:00:00.000Z'],
      ['ticketed', '2026-07-12T00:00:00.000Z'],
      ['orientation', '2026-07-17T00:00:00.000Z'],
      ['hired', '2026-07-20T00:00:00.000Z'],
    ),
  };
  const input: HiringAnalyticsInput = {
    leads: [
      {
        id: 'l1',
        source: 'job_board',
        campaignId: 'c1',
        status: 'converted',
        createdAt: '2026-06-20T00:00:00.000Z',
        hiringCaseId: 'hc_1',
      },
      {
        id: 'l2',
        source: 'job_board',
        campaignId: 'c1',
        status: 'dead',
        createdAt: '2026-06-22T00:00:00.000Z',
        hiringCaseId: null,
      },
      {
        id: 'l3',
        source: 'referral',
        campaignId: null,
        status: 'new',
        createdAt: '2026-08-01T00:00:00.000Z',
        hiringCaseId: null,
      },
      {
        id: 'old',
        source: 'referral',
        campaignId: null,
        status: 'dead',
        createdAt: '2026-01-01T00:00:00.000Z',
        hiringCaseId: null,
      },
    ],
    cases: [
      hiredCase,
      {
        id: 'hc_import',
        state: 'active_driver',
        openedAt: '2026-05-01T00:00:00.000Z',
        hiredAt: null,
        firstDispatchAt: null,
        employeeId: null,
        events: [],
      },
    ],
    costs: [
      {
        hiringCaseId: 'hc_1',
        leadId: null,
        campaignId: null,
        amount: 100,
        incurredOn: '2026-07-05',
      },
      { hiringCaseId: null, leadId: 'l1', campaignId: 'c1', amount: 50, incurredOn: '2026-06-21' },
      { hiringCaseId: null, leadId: 'l2', campaignId: 'c1', amount: 50, incurredOn: '2026-06-23' },
    ],
    campaigns: [
      {
        id: 'c1',
        name: 'Indeed',
        channel: 'job_board',
        periodStart: '2026-06-01',
        periodEnd: null,
      },
    ],
    // Dated spend (0038): one invoice in June, one in August.
    campaignSpend: [
      { campaignId: 'c1', amount: 250, spentOn: '2026-06-01' },
      { campaignId: 'c1', amount: 150, spentOn: '2026-08-15' },
    ],
    employees: [{ id: 'emp_1', status: 'active', terminationDate: null }],
    period,
    now,
  };

  it('counts the funnel from the period’s leads and says how far each source got', () => {
    const a = computeHiringAnalytics(input);
    expect(a.totals).toEqual({ leads: 3, converted: 1, hires: 1, activeDrivers: 0 });
    const jobBoard = a.funnelBySource.find((r) => r.key === 'job_board');
    expect(jobBoard).toMatchObject({ leads: 2, converted: 1, checks: 1, offer: 1, hired: 1 });
    expect(a.funnelByCampaign[0]).toMatchObject({
      label: 'Indeed',
      leads: 2,
      hired: 1,
      // The period holds both spend entries (400) and both per-lead fees (100): 500 over the
      // period's 2 leads and its 1 hire.
      spend: 500,
      spendEntries: 400,
      hiresInPeriod: 1,
      costPerLead: 250,
      costPerHire: 500,
      spendToDate: 500,
      leadsToDate: 2,
      hiresToDate: 1,
    });
  });

  it('scopes campaign spend, cost per lead and cost per hire to the period by the entry dates', () => {
    // June: the June invoice (250) and both June lead fees (100) over June's 2 leads; the hire
    // was in July, so June has no cost per hire.
    const june = computeHiringAnalytics({ ...input, period: { from: '2026-06-01', to: '2026-06-30' } });
    expect(june.funnelByCampaign[0]).toMatchObject({
      leads: 2,
      spend: 350,
      spendEntries: 250,
      hiresInPeriod: 0,
      costPerLead: 175,
      costPerHire: null,
      spendToDate: 500,
    });
    // August: only the August invoice; no leads and no hires, so both rates are unknown, not $0.
    const august = computeHiringAnalytics({ ...input, period: { from: '2026-08-01', to: '2026-08-31' } });
    expect(august.funnelByCampaign[0]).toMatchObject({
      leads: 0,
      spend: 150,
      costPerLead: null,
      costPerHire: null,
      leadsToDate: 2,
    });
    // The two months reconcile with the entries: 250 + 150 = 400 of dated spend.
    expect(june.funnelByCampaign[0]!.spendEntries + august.funnelByCampaign[0]!.spendEntries).toBe(400);
    // True cost takes only the spend dated in the period.
    expect(august.costPerHire.trueTotal).toBe(150);
    expect(sumSpend(input.campaignSpend, 'c1', { from: '2026-07-01', to: '2026-07-31' })).toBe(0);
    expect(sumSpend([...input.campaignSpend, { campaignId: 'c1', amount: 99, spentOn: '2026-06-02', voidedAt: '2026-06-03T00:00:00.000Z' }], 'c1')).toBe(400);
  });

  it('reads timestamps as Eastern business dates', () => {
    // 01:30 UTC on Sep 1 is 9:30 pm Eastern on Aug 31.
    expect(easternDay('2026-09-01T01:30:00.000Z')).toBe('2026-08-31');
    expect(easternDay('2026-09-01')).toBe('2026-09-01');
  });

  it('separates direct cost from true cost and footnotes what true counts', () => {
    const a = computeHiringAnalytics(input);
    // Direct: the hire's case and lead. True: every cost in the period, dead leads included, plus campaign spend.
    expect(a.costPerHire).toMatchObject({
      hires: 1,
      directTotal: 150,
      directPerHire: 150,
      trueTotal: 600,
      truePerHire: 600,
    });
    expect(
      a.costPerHire.notes.some((n) => n.includes('1 driver on the roster before the funnel')),
    ).toBe(true);
    expect(a.costPerHire.notes.some((n) => n.includes('dead leads'))).toBe(true);
  });

  it('measures days in stage from the appended events', () => {
    const a = computeHiringAnalytics(input);
    const offer = a.stageDurations.find((s) => s.stage === 'offer');
    expect(offer).toMatchObject({ n: 1, medianDays: 2, meanDays: 2 });
    expect(a.stageDurations.find((s) => s.stage === 'hired')?.n).toBe(0);
  });

  it('judges retention only where enough time has passed, and says why otherwise', () => {
    const a = computeHiringAnalytics(input);
    expect(a.retention.find((r) => r.days === 30)).toMatchObject({
      eligible: 1,
      retained: 1,
      rate: 1,
    });
    // Milestones are 30, 60 and 90 days (owner, 2026-10-01); the hire is 48 days old.
    expect(a.retention.map((r) => r.days)).toEqual([30, 60, 90]);
    expect(a.retention.find((r) => r.days === 60)).toMatchObject({
      eligible: 0,
      rate: null,
      reason: 'No hire in the period is 60 days old yet',
    });
    expect(a.retention.find((r) => r.days === 90)).toMatchObject({
      eligible: 0,
      rate: null,
      reason: 'No hire in the period is 90 days old yet',
    });
    expect(a.costPerRetainedHire90.value).toBeNull();
    const terminated = computeHiringAnalytics({
      ...input,
      employees: [{ id: 'emp_1', status: 'terminated', terminationDate: '2026-08-01' }],
    });
    expect(terminated.retention.find((r) => r.days === 30)).toMatchObject({
      eligible: 1,
      retained: 0,
      rate: 0,
    });
  });

  it('reports days to first load from the roster’s first dispatch, and the reason when there is none', () => {
    expect(computeHiringAnalytics(input).daysToFirstLoad).toEqual({
      n: 1,
      meanDays: 4,
      reason: null,
    });
    const undispatched = computeHiringAnalytics({
      ...input,
      cases: [{ ...hiredCase, firstDispatchAt: null }],
    });
    expect(undispatched.daysToFirstLoad.meanDays).toBeNull();
    expect(undispatched.daysToFirstLoad.reason).toMatch(/roster driver status/);
  });
});

describe('onboarding templates and the gate', () => {
  it('ships one driver template per driver type, with the lease only for lease operators', () => {
    const byType = new Map(DRIVER_ONBOARDING_TEMPLATES.map((t) => [t.driverType, t]));
    expect([...byType.keys()].sort()).toEqual(['company', 'lease_operator', 'owner_operator']);
    const has = (type: string, title: RegExp) =>
      byType.get(type as 'company')!.items.some((i) => title.test(i.title));
    expect(has('lease_operator', /Lease agreement/)).toBe(true);
    expect(has('company', /Lease agreement/)).toBe(false);
    expect(has('owner_operator', /Lease agreement/)).toBe(false);
    expect(has('company', /W-4/)).toBe(true);
    expect(has('owner_operator', /W-9/)).toBe(true);
    expect(has('lease_operator', /W-9/)).toBe(true);
    for (const t of DRIVER_ONBOARDING_TEMPLATES) {
      expect(t.items.some((i) => i.requirementCode === 'road_test' && i.blocking)).toBe(true);
      expect(t.items.some((i) => /ELD/.test(i.title))).toBe(true);
      expect(t.items.some((i) => /Fuel card/.test(i.title))).toBe(true);
      expect(t.items.every((i) => i.ownerRole)).toBe(true);
    }
  });

  it('the gate counts open blocking items only; skipped and completed do not hold', () => {
    const gate = onboardingGate('onb_1', [
      { title: 'Fuel card issued', blocking: true, status: 'pending' },
      { title: 'Truck assigned', blocking: true, status: 'blocked' },
      { title: 'Road test certificate filed', blocking: true, status: 'completed' },
      { title: 'Handbook', blocking: false, status: 'pending' },
      { title: 'W-9', blocking: true, status: 'skipped' },
    ]);
    expect(gate).toEqual({
      checklistId: 'onb_1',
      blockingOpen: 2,
      blockingTitles: ['Fuel card issued', 'Truck assigned'],
    });
  });
});
