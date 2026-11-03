import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNotNull, isNull, sql } from 'drizzle-orm';
import {
  DEFAULT_PREQUALIFICATION_RULES,
  Rng,
  DRIVER_ONBOARDING_TEMPLATES,
  SYSTEM_REQUIREMENTS,
  type CampaignChannel,
  prequalify,
  type Prequalification,
  type SaveDotApplicationInput,
} from '@neway/shared';
import { PinoLogger } from 'nestjs-pino';
import type { Principal } from '../common/auth/principal';
import { CLOCK, type Clock } from '../modules/dashboard/clock';
import { ComplianceService } from '../modules/compliance/compliance.service';
import { ConsentsService } from '../modules/compliance/consents.service';
import { VerificationService } from '../modules/compliance/verification.service';
import { DotApplicationsService } from '../modules/hiring/dot-applications.service';
import { CostLedgerService } from '../modules/hiring/cost-ledger.service';
import { OnboardingService } from '../modules/hr/onboarding.service';
import { HiringPipelineService } from '../modules/hiring/hiring-pipeline.service';
import { HiringService } from '../modules/hiring/hiring.service';
import { nextNumber, retryOnDuplicate } from '../modules/hr/hr.util';
import { RecruitingService } from '../modules/hr/recruiting.service';
import { DatabaseService } from './database.service';
import {
  hiringCampaigns,
  hiringCases,
  hiringDotApplications,
  hiringLeads,
} from './schema/hiring';
import { drivers } from './schema/roster';
import {
  applicants,
  offers,
  onboardingChecklists,
  onboardingItems,
  onboardingTemplateItems,
  onboardingTemplates,
} from './schema/hr';
import { employees } from './schema/people';
import { ROSTER_SEED } from './seed/roster.seed';

const DAY = 86_400_000;

/** Where a seeded candidate stops in the back of the funnel. */
export interface PipelinePlan {
  first: string;
  last: string;
  state: string;
  daysAgo: number;
  stop: 'offer_sent' | 'declined' | 'ticketed' | 'orientation' | 'hired';
  /** Fixes the pay preference (and so the offer's driver type); random when omitted. */
  driverType?: 'company' | 'owner_operator' | 'lease_operator';
}

/**
 * Thirty leads for the demo company, so the front of the funnel shows a realistic month rather
 * than an empty table: some never answered, some were prequalified this week, some failed a rule
 * and are waiting on a recruiter's decision, and the six who became the verification cases the
 * compliance seed opened are here as converted leads pointing at those cases.
 *
 * Deterministic (seed 11), once-only, and honest about what it is: every lead's `notes` says it
 * came from the demo import. Nothing here touches a real person's record.
 */
@Injectable()
export class HiringSeedService {
  constructor(
    private readonly database: DatabaseService,
    private readonly hiring: HiringService,
    private readonly recruiting: RecruitingService,
    private readonly applications: DotApplicationsService,
    private readonly pipeline: HiringPipelineService,
    private readonly ledger: CostLedgerService,
    private readonly onboardingService: OnboardingService,
    private readonly compliance: ComplianceService,
    private readonly consents: ConsentsService,
    private readonly verification: VerificationService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(HiringSeedService.name);
  }

  private get db() {
    return this.database.db;
  }

  async seed(): Promise<{ seeded: boolean; leads: number }> {
    const companyId = ROSTER_SEED.company.id;
    const [existing] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(hiringLeads)
      .where(eq(hiringLeads.companyId, companyId));
    if ((existing?.value ?? 0) > 0) return { seeded: false, leads: existing?.value ?? 0 };

    const rng = new Rng(11);
    const now = this.clock().getTime();
    const [recruiter] = await this.db
      .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
      .from(employees)
      .where(and(eq(employees.companyId, companyId), eq(employees.department, 'hr')))
      .orderBy(asc(employees.id))
      .limit(1);
    const recruiterName = recruiter ? `${recruiter.first} ${recruiter.last}` : 'Recruiting';

    // The six people the compliance seed opened cases for become converted leads.
    const cases = await this.db
      .select()
      .from(hiringCases)
      .where(eq(hiringCases.companyId, companyId))
      .orderBy(asc(hiringCases.openedAt));

    const FIRST = [
      'Darnell',
      'Luis',
      'Tyrone',
      'Hector',
      'Jamal',
      'Ivan',
      'Curtis',
      'Andre',
      'Rashid',
      'Miguel',
      'Terrell',
      'Dmitri',
      'Cedric',
      'Omar',
      'Vince',
      'Lamar',
      'Ruben',
      'Anthony',
      'Desmond',
      'Felix',
      'Maurice',
      'Nikolai',
      'Bryce',
      'Alonzo',
    ];
    const LAST = [
      'Whitfield',
      'Ortega',
      'Banks',
      'Delgado',
      'Pruitt',
      'Sokolov',
      'Mayfield',
      'Reyes',
      'Hakim',
      'Castillo',
      'Gaines',
      'Volkov',
      'Booker',
      'Farid',
      'Marino',
      'Tillman',
      'Acosta',
      'Lyle',
      'Pratt',
      'Navarro',
      'Beckett',
      'Orlov',
      'Hollis',
      'Vega',
    ];
    const STATES = ['TX', 'IL', 'OH', 'MO', 'TN', 'GA', 'IN', 'PA', 'MI', 'NC'];
    const SOURCES = [
      'job_board',
      'job_board',
      'referral',
      'website',
      'social',
      'agency',
      'walk_in',
    ] as const;

    const answers = (
      kind: 'clean' | 'young' | 'accidents' | 'dui' | 'green',
    ): Prequalification => ({
      age23Plus: kind !== 'young',
      cdlHeldYears: kind === 'green' ? 1 : rng.int(2, 15),
      otrExperienceYears: kind === 'green' ? 0.5 : rng.int(2, 12),
      accidents36mo: kind === 'accidents' ? rng.int(3, 4) : rng.int(0, 1),
      movingViolations36mo: rng.int(0, 2),
      duiEver: kind === 'dui',
      endorsements: rng.chance(0.4) ? ['H'] : rng.chance(0.3) ? ['N', 'T'] : [],
      payTypePreference: rng.pick([
        'company',
        'company',
        'owner_operator',
        'lease_operator',
      ] as const),
      homeState: rng.pick(STATES),
      earliestStartDate: null,
    });

    type Plan =
      | { kind: 'new' }
      | { kind: 'contacted' }
      | { kind: 'prequalified' }
      | { kind: 'flagged'; why: 'young' | 'accidents' | 'dui' | 'green' }
      | { kind: 'dead'; reason: string }
      | { kind: 'converted'; caseIndex: number };

    const plans: Plan[] = [
      ...cases.map((_, i): Plan => ({ kind: 'converted', caseIndex: i })),
      { kind: 'new' },
      { kind: 'new' },
      { kind: 'new' },
      { kind: 'new' },
      { kind: 'contacted' },
      { kind: 'contacted' },
      { kind: 'contacted' },
      { kind: 'contacted' },
      { kind: 'contacted' },
      { kind: 'prequalified' },
      { kind: 'prequalified' },
      { kind: 'prequalified' },
      { kind: 'prequalified' },
      { kind: 'flagged', why: 'accidents' },
      { kind: 'flagged', why: 'dui' },
      { kind: 'flagged', why: 'green' },
      { kind: 'dead', reason: 'Stopped responding after two calls' },
      { kind: 'dead', reason: 'Took a job with another carrier' },
      { kind: 'dead', reason: 'Wanted regional; only OTR open' },
      { kind: 'dead', reason: 'Under 23' },
      { kind: 'dead', reason: 'Pay expectation above the company plan' },
      { kind: 'dead', reason: 'Two accidents in 36 months; declined to proceed' },
      { kind: 'dead', reason: 'Never answered' },
      { kind: 'dead', reason: 'Never answered' },
    ];

    const rows: (typeof hiringLeads.$inferInsert)[] = [];
    let n = 1000;
    for (const plan of plans) {
      n += 1;
      const leadNumber = `LEAD-${n}`;
      const id = `lead_${n}`;
      const source = rng.pick(SOURCES);
      const daysAgo =
        plan.kind === 'new' ? 0 : plan.kind === 'converted' ? rng.int(20, 70) : rng.int(1, 28);
      const createdAt = new Date(now - daysAgo * DAY - rng.int(1, 9) * 3_600_000);
      const contactedAt =
        plan.kind === 'new' ? null : new Date(createdAt.getTime() + rng.int(1, 30) * 3_600_000);
      const base: typeof hiringLeads.$inferInsert = {
        id,
        companyId,
        leadNumber,
        firstName: rng.pick(FIRST),
        lastName: rng.pick(LAST),
        phone: `+1${rng.pick(['312', '773', '615', '214', '404', '317', '216'])}555${rng.digits(4)}`,
        email: rng.chance(0.75) ? `${leadNumber.toLowerCase()}@example.com` : null,
        cdlClass: 'A',
        state: rng.pick(STATES),
        yearsExperience: String(rng.int(1, 14)),
        source,
        campaignId: null,
        recruiterEmployeeId: recruiter?.id ?? null,
        notes: 'Demo import',
        status: 'new',
        createdAt,
        contactedAt,
        updatedAt: createdAt,
      };

      if (plan.kind === 'new') rows.push(base);
      else if (plan.kind === 'contacted') rows.push({ ...base, status: 'contacted' });
      else if (plan.kind === 'prequalified' || plan.kind === 'converted') {
        const a = answers('clean');
        const at = new Date((contactedAt ?? createdAt).getTime() + rng.int(1, 48) * 3_600_000);
        const result = prequalify(a, DEFAULT_PREQUALIFICATION_RULES);
        const row: typeof hiringLeads.$inferInsert = {
          ...base,
          status: 'prequalified',
          prequalification: { ...a, recordedAt: at.toISOString(), recordedBy: recruiterName },
          prequalResult: { ...result, evaluatedAt: at.toISOString() },
          prequalifiedAt: at,
        };
        if (plan.kind === 'converted') {
          const c = cases[plan.caseIndex]!;
          const [first, ...rest] = c.candidateName.split(' ');
          row.firstName = first ?? c.candidateName;
          row.lastName = rest.join(' ') || row.lastName;
          row.status = 'converted';
          row.hiringCaseId = c.id;
          row.convertedAt = c.openedAt;
          row.createdAt = new Date(c.openedAt.getTime() - rng.int(3, 10) * DAY);
          row.contactedAt = new Date(row.createdAt.getTime() + rng.int(2, 24) * 3_600_000);
          row.prequalifiedAt = new Date(row.contactedAt.getTime() + rng.int(1, 48) * 3_600_000);
          row.updatedAt = c.openedAt;
        }
        rows.push(row);
      } else if (plan.kind === 'flagged') {
        const a = answers(plan.why);
        const at = new Date((contactedAt ?? createdAt).getTime() + rng.int(1, 48) * 3_600_000);
        const result = prequalify(a, DEFAULT_PREQUALIFICATION_RULES);
        rows.push({
          ...base,
          status: 'contacted',
          prequalification: { ...a, recordedAt: at.toISOString(), recordedBy: recruiterName },
          prequalResult: { ...result, evaluatedAt: at.toISOString() },
        });
      } else {
        rows.push({
          ...base,
          status: 'dead',
          deadAt: new Date((contactedAt ?? createdAt).getTime() + rng.int(1, 5) * DAY),
          deadReason: plan.reason,
        });
      }
    }

    await this.db.insert(hiringLeads).values(rows);

    // Converted leads point at the applicant their case will carry once one exists; the six
    // backfilled cases predate the funnel and have none, which the screen states rather than hides.
    const linked = rows.filter((r) => r.hiringCaseId);
    for (const row of linked) {
      const [apl] = await this.db
        .select({ id: applicants.id })
        .from(applicants)
        .where(
          and(
            eq(applicants.companyId, companyId),
            eq(applicants.firstName, row.firstName),
            eq(applicants.lastName, row.lastName),
          ),
        )
        .limit(1);
      if (apl)
        await this.db
          .update(hiringLeads)
          .set({ applicantId: apl.id })
          .where(eq(hiringLeads.id, row.id!));
    }

    this.logger.info(
      { leads: rows.length, converted: linked.length },
      'Leads built for the demo funnel',
    );
    return { seeded: true, leads: rows.length };
  }

  /**
   * Three candidates at the Application stage, so the DOT application is populated end to end:
   * two submitted through the real submit path (a rendered PDF in the qualification file, a
   * verification case, employer consents drafted) and one still a draft. Once-only, keyed on the
   * application table being empty; the leads it converts are added beside the thirty above.
   */
  async seedDotApplications(): Promise<{ seeded: boolean; applications: number }> {
    const companyId = ROSTER_SEED.company.id;
    const [existing] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(hiringDotApplications)
      .where(eq(hiringDotApplications.companyId, companyId));
    if ((existing?.value ?? 0) > 0) return { seeded: false, applications: existing?.value ?? 0 };

    const rng = new Rng(13);
    const now = this.clock().getTime();
    const [recruiter] = await this.db
      .select({
        id: employees.id,
        userId: employees.userId,
        first: employees.firstName,
        last: employees.lastName,
      })
      .from(employees)
      .where(and(eq(employees.companyId, companyId), eq(employees.department, 'hr')))
      .orderBy(asc(employees.id))
      .limit(1);
    const recruiterName = recruiter ? `${recruiter.first} ${recruiter.last}` : 'Recruiting';
    const principal: Principal = {
      userId: recruiter?.userId ?? 'system',
      userName: recruiterName,
      companyId,
      companyTimezone: ROSTER_SEED.company.timezone,
      weekStart: 1,
      roles: [],
      permissions: new Set(),
    };
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

    const plans = [
      {
        first: 'Terrell',
        last: 'Gaines',
        state: 'GA',
        daysAgo: 9,
        kind: 'submitted' as const,
        submitAfterDays: 1,
      },
      {
        first: 'Ruben',
        last: 'Acosta',
        state: 'TX',
        daysAgo: 6,
        kind: 'submitted' as const,
        submitAfterDays: 2,
      },
      {
        first: 'Desmond',
        last: 'Pratt',
        state: 'OH',
        daysAgo: 3,
        kind: 'draft' as const,
        submitAfterDays: 0,
      },
    ];

    let built = 0;
    for (const plan of plans) {
      const openedAt = new Date(now - plan.daysAgo * DAY - rng.int(1, 8) * 3_600_000);
      const createdAt = new Date(openedAt.getTime() - rng.int(4, 12) * DAY);
      const contactedAt = new Date(createdAt.getTime() + rng.int(2, 30) * 3_600_000);
      const prequalifiedAt = new Date(contactedAt.getTime() + rng.int(1, 48) * 3_600_000);
      const a: Prequalification = {
        age23Plus: true,
        cdlHeldYears: rng.int(3, 12),
        otrExperienceYears: rng.int(2, 10),
        accidents36mo: 0,
        movingViolations36mo: rng.int(0, 1),
        duiEver: false,
        endorsements: rng.chance(0.5) ? ['H'] : [],
        payTypePreference: rng.pick(['company', 'company', 'lease_operator'] as const),
        homeState: plan.state,
        earliestStartDate: null,
      };
      const result = prequalify(a, DEFAULT_PREQUALIFICATION_RULES);
      const email = `${plan.first}.${plan.last}@example.com`.toLowerCase();
      const phone = `+1${rng.pick(['312', '773', '615', '214', '404'])}555${rng.digits(4)}`;

      const applicant = await this.recruiting.createApplicant(principal, {
        firstName: plan.first,
        lastName: plan.last,
        email,
        phone,
        position: 'Driver',
        department: 'dispatch',
        jobOpeningId: null,
        location: plan.state,
        source: 'job_board',
        assignedRecruiterEmployeeId: recruiter?.id ?? null,
        driverType: a.payTypePreference,
        appliedOn: day(openedAt.getTime()),
        notes: 'Demo import',
      });
      const caseId = await this.hiring.openForApplicant(principal, {
        applicantId: applicant.id,
        candidateName: `${plan.first} ${plan.last}`,
        recruiterId: recruiter?.id ?? null,
        recruiterName,
        history: [
          { state: 'lead', at: createdAt, byName: recruiterName },
          { state: 'prequalified', at: prequalifiedAt, byName: recruiterName },
          { state: 'application', at: openedAt, byName: recruiterName },
        ],
      });
      await retryOnDuplicate(async () => {
        const leadNumber = await nextNumber(
          this.db,
          hiringLeads,
          hiringLeads.leadNumber,
          hiringLeads.companyId,
          companyId,
          'LEAD',
          1000,
        );
        await this.db.insert(hiringLeads).values({
          id: `lead_${leadNumber.slice(5)}`,
          companyId,
          leadNumber,
          firstName: plan.first,
          lastName: plan.last,
          phone,
          email,
          cdlClass: 'A',
          state: plan.state,
          yearsExperience: String(a.otrExperienceYears),
          source: 'job_board',
          campaignId: null,
          recruiterEmployeeId: recruiter?.id ?? null,
          notes: 'Demo import',
          status: 'converted',
          prequalification: {
            ...a,
            recordedAt: prequalifiedAt.toISOString(),
            recordedBy: recruiterName,
          },
          prequalResult: { ...result, evaluatedAt: prequalifiedAt.toISOString() },
          applicantId: applicant.id,
          hiringCaseId: caseId,
          createdAt,
          contactedAt,
          prequalifiedAt,
          convertedAt: openedAt,
          updatedAt: openedAt,
        });
      });

      const savedAt = new Date(openedAt.getTime() + rng.int(1, 4) * 3_600_000);
      const form = this.demoApplication(
        rng,
        plan,
        day(savedAt.getTime()),
        plan.kind === 'submitted',
      );
      await this.applications.save(principal, caseId, form, { at: savedAt });
      if (plan.kind === 'submitted') {
        const submittedAt = new Date(
          savedAt.getTime() + plan.submitAfterDays * DAY + rng.int(1, 6) * 3_600_000,
        );
        await this.applications.submit(principal, caseId, { at: submittedAt });
      }
      built += 1;
    }
    this.logger.info({ applications: built }, 'DOT applications built for the demo funnel');
    return { seeded: true, applications: built };
  }

  /**
   * The back of the funnel, populated: four candidates carried through the real services — the
   * file completed and verified, the safety decision recorded, then an offer sent, an offer
   * accepted with travel booked, orientation attended with a road test passed, and one hire that
   * opened an employee and a roster row — plus one who declined. Once-only, keyed on the tickets
   * table being empty. Every write goes through the same code a recruiter's click would.
   */
  async seedPipeline(custom?: PipelinePlan[]): Promise<{ seeded: boolean; cases: number }> {
    const companyId = ROSTER_SEED.company.id;
    // Idempotent per candidate (each plan is skipped once its applicant exists), so a plan added
    // later lands on the next boot without touching the ones already built.

    // The demo set is deterministic; a caller's own candidates (tests) get fresh numbers.
    const rng = new Rng(custom ? Date.now() % 100_000 : 17);
    const now = this.clock().getTime();
    const [recruiter] = await this.db
      .select({
        id: employees.id,
        userId: employees.userId,
        first: employees.firstName,
        last: employees.lastName,
      })
      .from(employees)
      .where(and(eq(employees.companyId, companyId), eq(employees.department, 'hr')))
      .orderBy(asc(employees.id))
      .limit(1);
    const [safety] = await this.db
      .select({ userId: employees.userId, first: employees.firstName, last: employees.lastName })
      .from(employees)
      .where(and(eq(employees.companyId, companyId), eq(employees.department, 'safety')))
      .orderBy(asc(employees.id))
      .limit(1);
    const [dispatcher] = await this.db
      .select({ id: drivers.dispatcherId })
      .from(drivers)
      .where(eq(drivers.companyId, companyId))
      .orderBy(asc(drivers.id))
      .limit(1);
    const recruiterName = recruiter ? `${recruiter.first} ${recruiter.last}` : 'Recruiting';
    const base = {
      companyId,
      companyTimezone: ROSTER_SEED.company.timezone,
      weekStart: 1,
      roles: [],
      permissions: new Set<string>(),
    };
    const principal: Principal = {
      ...base,
      userId: recruiter?.userId ?? 'system',
      userName: recruiterName,
    };
    const safetyPrincipal: Principal = {
      ...base,
      userId: safety?.userId ?? 'system',
      userName: safety ? `${safety.first} ${safety.last}` : 'Safety',
    };
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const hours = (n: number) => n * 3_600_000;

    const plans: PipelinePlan[] = custom ?? [
      { first: 'Curtis', last: 'Mayfield', state: 'TN', daysAgo: 34, stop: 'offer_sent' },
      { first: 'Felix', last: 'Navarro', state: 'IL', daysAgo: 38, stop: 'declined' },
      { first: 'Lamar', last: 'Tillman', state: 'GA', daysAgo: 41, stop: 'ticketed' },
      { first: 'Omar', last: 'Farid', state: 'TX', daysAgo: 46, stop: 'orientation' },
      {
        first: 'Anthony',
        last: 'Lyle',
        state: 'MO',
        daysAgo: 55,
        stop: 'hired',
        driverType: 'company',
      },
      {
        first: 'Rashid',
        last: 'Hakim',
        state: 'IL',
        daysAgo: 62,
        stop: 'hired',
        driverType: 'lease_operator',
      },
      {
        first: 'Ivan',
        last: 'Sokolov',
        state: 'IN',
        daysAgo: 58,
        stop: 'hired',
        driverType: 'owner_operator',
      },
    ];

    let built = 0;
    for (const plan of plans) {
      // A boot that failed part-way leaves a candidate behind; do not make them twice.
      const [already] = await this.db
        .select({ id: applicants.id })
        .from(applicants)
        .where(
          and(
            eq(applicants.companyId, companyId),
            eq(applicants.firstName, plan.first),
            eq(applicants.lastName, plan.last),
          ),
        )
        .limit(1);
      if (already) continue;
      // ---- lead → candidate → application, as the DOT application seed does it
      const openedAt = new Date(now - plan.daysAgo * DAY - rng.int(1, 8) * hours(1));
      const createdAt = new Date(openedAt.getTime() - rng.int(4, 12) * DAY);
      const contactedAt = new Date(createdAt.getTime() + rng.int(2, 30) * hours(1));
      const prequalifiedAt = new Date(contactedAt.getTime() + rng.int(1, 48) * hours(1));
      const a: Prequalification = {
        age23Plus: true,
        cdlHeldYears: rng.int(3, 12),
        otrExperienceYears: rng.int(2, 10),
        accidents36mo: 0,
        movingViolations36mo: rng.int(0, 1),
        duiEver: false,
        endorsements: rng.chance(0.5) ? ['H'] : [],
        payTypePreference:
          plan.driverType ?? rng.pick(['company', 'company', 'lease_operator'] as const),
        homeState: plan.state,
        earliestStartDate: null,
      };
      const result = prequalify(a, DEFAULT_PREQUALIFICATION_RULES);
      const email = `${plan.first}.${plan.last}@example.com`.toLowerCase();
      const phone = `+1${rng.pick(['312', '773', '615', '214', '404'])}555${rng.digits(4)}`;
      const applicant = await this.recruiting.createApplicant(principal, {
        firstName: plan.first,
        lastName: plan.last,
        email,
        phone,
        position: 'Driver',
        department: 'dispatch',
        jobOpeningId: null,
        location: plan.state,
        source: rng.pick(['job_board', 'referral', 'website'] as const),
        assignedRecruiterEmployeeId: recruiter?.id ?? null,
        driverType: a.payTypePreference,
        appliedOn: day(openedAt.getTime()),
        notes: 'Demo import',
      });
      const caseId = await this.hiring.openForApplicant(principal, {
        applicantId: applicant.id,
        candidateName: `${plan.first} ${plan.last}`,
        recruiterId: recruiter?.id ?? null,
        recruiterName,
        history: [
          { state: 'lead', at: createdAt, byName: recruiterName },
          { state: 'prequalified', at: prequalifiedAt, byName: recruiterName },
          { state: 'application', at: openedAt, byName: recruiterName },
        ],
      });
      await retryOnDuplicate(async () => {
        const leadNumber = await nextNumber(
          this.db,
          hiringLeads,
          hiringLeads.leadNumber,
          hiringLeads.companyId,
          companyId,
          'LEAD',
          1000,
        );
        await this.db.insert(hiringLeads).values({
          id: `lead_${leadNumber.slice(5)}`,
          companyId,
          leadNumber,
          firstName: plan.first,
          lastName: plan.last,
          phone,
          email,
          cdlClass: 'A',
          state: plan.state,
          yearsExperience: String(a.otrExperienceYears),
          source: applicant.source ?? 'job_board',
          campaignId: null,
          recruiterEmployeeId: recruiter?.id ?? null,
          notes: 'Demo import',
          status: 'converted',
          prequalification: {
            ...a,
            recordedAt: prequalifiedAt.toISOString(),
            recordedBy: recruiterName,
          },
          prequalResult: { ...result, evaluatedAt: prequalifiedAt.toISOString() },
          applicantId: applicant.id,
          hiringCaseId: caseId,
          createdAt,
          contactedAt,
          prequalifiedAt,
          convertedAt: openedAt,
          updatedAt: openedAt,
        });
      });
      const savedAt = new Date(openedAt.getTime() + rng.int(1, 4) * hours(1));
      await this.applications.save(
        principal,
        caseId,
        this.demoApplication(rng, plan, day(savedAt.getTime()), true),
        { at: savedAt },
      );
      const submittedAt = new Date(savedAt.getTime() + rng.int(6, 30) * hours(1));
      const application = await this.applications.submit(principal, caseId, { at: submittedAt });
      const driverId = application.driverId as string;
      const name = `${plan.first} ${plan.last}`;

      // ---- the file: documents, consents, screenings, safety decision → Offer
      let t = submittedAt.getTime();
      // Safety reads the application first; it is the first document in the file.
      t += rng.int(2, 12) * hours(1);
      await this.compliance.verifyDocument(safetyPrincipal, application.documentId as string, {
        at: new Date(t),
      });
      const upload = async (
        code: string,
        title: string,
        expiresOn: string | null,
        issuedOn: string | null,
      ) => {
        t += rng.int(3, 20) * hours(1);
        // Annual checks (MVR, PSP, clearinghouse) expire; the catalog says which, not this seed.
        if (expiresOn === null && SYSTEM_REQUIREMENTS.find((r) => r.code === code)?.hasExpiry) {
          expiresOn = day(t + 365 * DAY);
        }
        const { document } = await this.compliance.upload(principal, {
          ownerType: 'driver',
          ownerId: driverId,
          ownerLabel: name,
          requirementCode: code,
          title,
          fileName: `${code.replace(/_/g, '-')}-${driverId}.pdf`,
          contentType: 'application/pdf',
          sizeBytes: rng.int(80_000, 600_000),
          issuedOn,
          expiresOn,
          source: 'staff',
          at: new Date(t),
        });
        t += rng.int(1, 8) * hours(1);
        await this.compliance.verifyDocument(safetyPrincipal, document.id, { at: new Date(t) });
      };
      const year = Number(day(t).slice(0, 4));
      await upload(
        'cdl',
        'Commercial driver licence',
        `${year + rng.int(1, 4)}-0${rng.int(1, 9)}-15`,
        `${year - 3}-05-01`,
      );
      await upload(
        'medical_card',
        'DOT medical certificate',
        `${year + 1}-0${rng.int(1, 9)}-01`,
        day(t),
      );
      await upload(
        'work_authorization',
        'Work authorization',
        `${year + 6}-01-01`,
        `${year - 4}-01-01`,
      );
      for (const purpose of [
        'mvr',
        'psp',
        'background_check',
        'clearinghouse',
        'drug_alcohol_testing',
      ] as const) {
        t += rng.int(1, 6) * hours(1);
        const consent = await this.consents.create(principal, {
          driverId,
          purpose,
          at: new Date(t),
        });
        await this.consents.send(principal, consent.id, { at: new Date(t + hours(1)) });
        t += rng.int(4, 40) * hours(1);
        await this.consents.respond(
          principal,
          consent.id,
          { outcome: 'signed' },
          { at: new Date(t) },
        );
      }
      const employerConsents = await this.consents.list(principal, {
        driverId,
        purpose: 'employment_verification',
      });
      for (const consent of employerConsents) {
        await this.consents.send(principal, consent.id, { at: new Date(t + hours(1)) });
        t += rng.int(4, 30) * hours(1);
        await this.consents.respond(
          principal,
          consent.id,
          { outcome: 'signed' },
          { at: new Date(t) },
        );
      }
      await upload('mvr_review', 'Motor vehicle record', null, day(t));
      await upload('psp_review', 'PSP report', null, day(t));
      await upload('background_check', 'Background check report', null, day(t));
      await upload('clearinghouse_query', 'Clearinghouse query result', null, day(t));
      await upload('pre_employment_drug_test', 'Pre-employment drug test result', null, day(t));
      await upload(
        'employment_verification',
        'Previous employer verification responses',
        null,
        day(t),
      );
      t += rng.int(12, 48) * hours(1);
      // Safety picks the file up, then decides: an approval needs the review under way.
      await this.verification.startReview(safetyPrincipal, application.verificationCaseId as string, {
        at: new Date(t - hours(2)),
      });
      await this.verification.recordDecision(
        safetyPrincipal,
        application.verificationCaseId as string,
        { decision: 'approved', conditions: [], note: null },
        { at: new Date(t) },
      );
      // The decision reaches the case through the audit stream; make sure it landed before moving on.
      await this.hiring.resync(companyId, caseId);

      // ---- offer
      t += rng.int(4, 30) * hours(1);
      const orientationDate = day(t + rng.int(7, 14) * DAY);
      const driverType = a.payTypePreference ?? 'company';
      await this.pipeline.createOffer(
        principal,
        caseId,
        {
          driverType,
          payPlan:
            driverType === 'company'
              ? { kind: 'per_mile', rate: rng.pick([0.58, 0.6, 0.62, 0.65]) }
              : { kind: 'percent_of_linehaul', rate: rng.pick([68, 70, 72]) },
          signOnBonus: rng.chance(0.6) ? rng.pick([1000, 1500, 2500]) : null,
          referralBonus: null,
          referringDriverId: null,
          orientationDate,
          expiresOn: day(t + 5 * DAY),
          notes: null,
        },
        { at: new Date(t) },
      );
      t += rng.int(1, 8) * hours(1);
      await this.pipeline.setOfferStatus(principal, caseId, 'sent', { at: new Date(t) });
      if (plan.stop === 'offer_sent') {
        built += 1;
        continue;
      }
      t += rng.int(12, 60) * hours(1);
      if (plan.stop === 'declined') {
        await this.pipeline.setOfferStatus(principal, caseId, 'declined', { at: new Date(t) });
        built += 1;
        continue;
      }
      await this.pipeline.setOfferStatus(principal, caseId, 'accepted', { at: new Date(t) });

      // ---- ticket
      t += rng.int(4, 24) * hours(1);
      const departAt = new Date(
        Date.parse(`${orientationDate}T00:00:00Z`) - DAY + hours(rng.int(6, 14)),
      );
      await this.pipeline.bookTicket(
        principal,
        caseId,
        {
          travelMode: rng.pick(['bus', 'flight', 'bus'] as const),
          carrier: rng.pick(['Greyhound', 'American Airlines', 'Southwest']),
          bookingReference: rng.digits(6).toUpperCase(),
          departAt: departAt.toISOString(),
          arriveAt: new Date(departAt.getTime() + hours(rng.int(3, 12))).toISOString(),
          travelCost: rng.pick([89, 145, 210, 265]),
          lodgingNights: 3,
          lodgingCost: rng.pick([267, 315, 348]),
          notes: null,
        },
        { at: new Date(t) },
      );
      if (plan.stop === 'ticketed') {
        built += 1;
        continue;
      }

      // ---- orientation
      const orientationStart = Date.parse(`${orientationDate}T14:00:00Z`);
      const orientation = await this.pipeline.recordOrientation(
        principal,
        caseId,
        {
          startDate: orientationDate,
          days: 3,
          perDayPay: 150,
          attendance: 'attended',
          roadTest: {
            result: 'pass',
            testedOn: day(orientationStart + 2 * DAY),
            examinerName: safetyPrincipal.userName ?? 'Safety',
            vehicleType: 'Tractor-semitrailer',
            notes: null,
          },
          completedOn: day(orientationStart + 2 * DAY),
          notes: null,
        },
        { at: new Date(orientationStart + 2 * DAY + hours(3)) },
      );
      // The road test certificate is filed for review, never accepted by being filed; Safety
      // verifies it before the hire, as it would any other document.
      if (orientation.roadTestDocumentId) {
        await this.compliance.verifyDocument(safetyPrincipal, orientation.roadTestDocumentId, {
          at: new Date(orientationStart + 2 * DAY + hours(5)),
        });
      }
      if (plan.stop === 'orientation') {
        built += 1;
        continue;
      }

      // ---- hire
      await this.pipeline.hire(
        principal,
        caseId,
        {
          hireDate: day(orientationStart + 3 * DAY),
          dispatcherId: dispatcher?.id ?? 'usr_002',
          managerEmployeeId: null,
          preferredLanguage: 'en',
          startOnboarding: true,
        },
        { at: new Date(orientationStart + 3 * DAY + hours(2)) },
      );
      built += 1;
    }
    this.logger.info(
      { cases: built },
      'Offer, ticket, orientation and hire built for the demo funnel',
    );
    return { seeded: true, cases: built };
  }

  /**
   * Where the demo leads came from and what it cost: five campaigns, one per source the leads
   * carry, with spend for the period; every lead without a campaign is attributed by its source;
   * and a handful of typed-in costs (a job-board posting fee, a welcome kit) beside the ones the
   * ledger prices on its own. Once-only, keyed on the campaigns table.
   */
  async seedCampaigns(): Promise<{ seeded: boolean; campaigns: number }> {
    const companyId = ROSTER_SEED.company.id;
    const [existing] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(hiringCampaigns)
      .where(eq(hiringCampaigns.companyId, companyId));
    if ((existing?.value ?? 0) > 0) return { seeded: false, campaigns: existing?.value ?? 0 };

    const now = this.clock().getTime();
    const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
    const [recruiter] = await this.db
      .select({
        id: employees.id,
        userId: employees.userId,
        first: employees.firstName,
        last: employees.lastName,
      })
      .from(employees)
      .where(and(eq(employees.companyId, companyId), eq(employees.department, 'hr')))
      .orderBy(asc(employees.id))
      .limit(1);
    const principal: Principal = {
      userId: recruiter?.userId ?? 'system',
      userName: recruiter ? `${recruiter.first} ${recruiter.last}` : 'Recruiting',
      companyId,
      companyTimezone: ROSTER_SEED.company.timezone,
      weekStart: 1,
      roles: [],
      permissions: new Set(),
    };

    const plans: {
      name: string;
      channel: CampaignChannel;
      source: string;
      spend: number;
      startDaysAgo: number;
      ended: boolean;
    }[] = [
      {
        name: 'Indeed sponsored — OTR Q3',
        channel: 'job_board',
        source: 'job_board',
        spend: 2400,
        startDaysAgo: 75,
        ended: false,
      },
      {
        name: 'Driver referral program',
        channel: 'referral',
        source: 'referral',
        spend: 0,
        startDaysAgo: 180,
        ended: false,
      },
      {
        name: 'Facebook driver groups — August',
        channel: 'social',
        source: 'social',
        spend: 650,
        startDaysAgo: 40,
        ended: true,
      },
      {
        name: 'Careers page',
        channel: 'website',
        source: 'website',
        spend: 0,
        startDaysAgo: 365,
        ended: false,
      },
      {
        name: 'Midwest Driver Staffing (agency)',
        channel: 'agency',
        source: 'agency',
        spend: 1800,
        startDaysAgo: 60,
        ended: false,
      },
    ];
    const bySource = new Map<string, string>();
    for (const plan of plans) {
      const start = now - plan.startDaysAgo * DAY;
      const campaign = await this.ledger.createCampaign(
        principal,
        {
          name: plan.name,
          channel: plan.channel,
          periodStart: day(start),
          periodEnd: plan.ended ? day(now - 10 * DAY) : null,
          spend: plan.spend,
          ownerEmployeeId: recruiter?.id ?? null,
          notes: 'Demo import',
          active: !plan.ended,
        },
        { at: new Date(start) },
      );
      bySource.set(plan.source, campaign.id);
    }
    // Leads are attributed by the source they were recorded with; walk-ins stay unattributed.
    for (const [source, campaignId] of bySource) {
      await this.db
        .update(hiringLeads)
        .set({ campaignId })
        .where(
          and(
            eq(hiringLeads.companyId, companyId),
            eq(hiringLeads.source, source),
            isNull(hiringLeads.campaignId),
          ),
        );
    }

    // A few costs a person typed in, beside what the ledger prices on its own.
    const hired = await this.db
      .select({ id: hiringCases.id, hiredAt: hiringCases.hiredAt })
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, companyId), isNotNull(hiringCases.hiredAt)));
    for (const c of hired) {
      await this.ledger.create(principal, {
        hiringCaseId: c.id,
        leadId: null,
        campaignId: null,
        type: 'other',
        amount: 85,
        incurredOn: day((c.hiredAt as Date).getTime()),
        note: 'Welcome kit and uniform',
      });
    }
    const jobBoardLeads = await this.db
      .select({
        id: hiringLeads.id,
        createdAt: hiringLeads.createdAt,
        campaignId: hiringLeads.campaignId,
      })
      .from(hiringLeads)
      .where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.source, 'agency')))
      .limit(3);
    for (const lead of jobBoardLeads) {
      await this.ledger.create(principal, {
        hiringCaseId: null,
        leadId: lead.id,
        campaignId: lead.campaignId,
        type: 'lead_acquisition',
        amount: 250,
        incurredOn: day(lead.createdAt.getTime()),
        note: 'Agency placement fee, per lead',
      });
    }
    this.logger.info({ campaigns: plans.length }, 'Campaigns built for the demo funnel');
    return { seeded: true, campaigns: plans.length };
  }

  /**
   * The onboarding templates: one per driver type, from the shared seed list. Once-only, keyed on
   * the templates table. The plans the earlier seeds created from the built-in item list are
   * rebuilt from the template so the demo's hired driver shows the gate; a plan somebody has
   * already worked on (any item touched) is left alone.
   */
  async seedOnboardingTemplates(): Promise<{ seeded: boolean; templates: number }> {
    const companyId = ROSTER_SEED.company.id;
    const [existing] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(onboardingTemplates)
      .where(eq(onboardingTemplates.companyId, companyId));
    if ((existing?.value ?? 0) > 0) return { seeded: false, templates: existing?.value ?? 0 };

    const byDriverType = new Map<string, string>();
    for (const seed of DRIVER_ONBOARDING_TEMPLATES) {
      const id = `ont_${crypto.randomUUID()}`;
      await this.db.insert(onboardingTemplates).values({
        id,
        companyId,
        name: seed.name,
        position: seed.position,
        department: seed.department,
        employmentType: null,
        driverType: seed.driverType,
        isDefault: seed.isDefault,
      });
      await this.db.insert(onboardingTemplateItems).values(
        seed.items.map((item, index) => ({
          id: `onti_${crypto.randomUUID()}`,
          templateId: id,
          title: item.title,
          category: item.category,
          dueOffsetDays: item.dueOffsetDays,
          sortOrder: index,
          blocking: item.blocking ?? false,
          ownerRole: item.ownerRole ?? null,
          requirementCode: item.requirementCode ?? null,
        })),
      );
      if (seed.driverType) byDriverType.set(seed.driverType, id);
    }

    // Rebuild the untouched default plans of the funnel's own hires from their template.
    const hired = await this.db
      .select({
        caseId: hiringCases.id,
        employeeId: hiringCases.employeeId,
        driverId: hiringCases.driverId,
        offerId: hiringCases.offerId,
      })
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, companyId), isNotNull(hiringCases.employeeId)));
    let rebuilt = 0;
    for (const h of hired) {
      const [checklist] = await this.db
        .select()
        .from(onboardingChecklists)
        .where(
          and(
            eq(onboardingChecklists.employeeId, h.employeeId as string),
            sql`${onboardingChecklists.status} <> 'cancelled'`,
          ),
        )
        .limit(1);
      if (!checklist || checklist.templateId) continue;
      const items = await this.db
        .select()
        .from(onboardingItems)
        .where(eq(onboardingItems.checklistId, checklist.id));
      if (items.some((i) => i.status !== 'pending')) continue;
      const [offer] = h.offerId
        ? await this.db
            .select({ driverType: offers.driverType })
            .from(offers)
            .where(eq(offers.id, h.offerId))
            .limit(1)
        : [];
      const templateId = byDriverType.get(offer?.driverType ?? 'company');
      const seed = DRIVER_ONBOARDING_TEMPLATES.find(
        (t) => t.driverType === (offer?.driverType ?? 'company'),
      );
      if (!templateId || !seed) continue;
      await this.db.delete(onboardingItems).where(eq(onboardingItems.checklistId, checklist.id));
      await this.db.insert(onboardingItems).values(
        seed.items.map((item, index) => ({
          id: `oni_${crypto.randomUUID()}`,
          checklistId: checklist.id,
          title: item.title,
          category: item.category,
          ownerEmployeeId: checklist.ownerEmployeeId,
          dueDate: new Date(
            Date.parse(`${checklist.startDate}T00:00:00Z`) + item.dueOffsetDays * DAY,
          )
            .toISOString()
            .slice(0, 10),
          status: 'pending',
          sortOrder: index,
          blocking: item.blocking ?? false,
          ownerRole: item.ownerRole ?? null,
          requirementCode: item.requirementCode ?? null,
        })),
      );
      await this.db
        .update(onboardingChecklists)
        .set({ templateId })
        .where(eq(onboardingChecklists.id, checklist.id));
      if (h.driverId) await this.onboardingService.syncFromFile(companyId, h.driverId);
      rebuilt += 1;
    }
    this.logger.info(
      { templates: DRIVER_ONBOARDING_TEMPLATES.length, rebuilt },
      'Onboarding templates installed',
    );
    return { seeded: true, templates: DRIVER_ONBOARDING_TEMPLATES.length };
  }

  /** A plausible 391.21 form for one demo candidate; complete and signed, or an unsigned draft. */
  private demoApplication(
    rng: Rng,
    who: { first: string; last: string; state: string },
    signedOn: string,
    complete: boolean,
  ): SaveDotApplicationInput {
    const year = Number(signedOn.slice(0, 4));
    const carriers = [
      'Blue Line Logistics',
      'Prairie Freight Lines',
      'Summit Carriers',
      'Eastgate Transport',
      'Ridgeway Trucking',
    ];
    const first = rng.pick(carriers);
    let second = rng.pick(carriers);
    while (second === first) second = rng.pick(carriers);
    const employment: SaveDotApplicationInput['employment'] = complete
      ? [
          {
            kind: 'employer',
            employer: first,
            address: `${rng.int(100, 9900)} Industrial Pkwy, Dallas, TX`,
            phone: `+1214555${rng.digits(4)}`,
            contactName: 'Safety department',
            position: 'OTR driver',
            from: `${year - 2}-06-01`,
            to: null,
            reasonForLeaving: 'Seeking better home time',
            droveCmv: true,
            dotRegulated: true,
            subjectToDrugTesting: true,
          },
          {
            kind: 'employer',
            employer: second,
            address: `${rng.int(100, 9900)} Commerce Dr, Memphis, TN`,
            phone: `+1901555${rng.digits(4)}`,
            contactName: 'HR',
            position: 'Regional driver',
            from: `${year - 7}-03-15`,
            to: `${year - 2}-06-01`,
            reasonForLeaving: 'Company reduced regional lanes',
            droveCmv: true,
            dotRegulated: true,
            subjectToDrugTesting: true,
          },
          {
            kind: 'employer',
            employer: 'Metro Building Supply',
            address: `${who.state} warehouse`,
            phone: null,
            contactName: null,
            position: 'Warehouse associate',
            from: `${year - 11}-01-10`,
            to: `${year - 7}-03-15`,
            reasonForLeaving: 'Obtained CDL',
            droveCmv: false,
            dotRegulated: false,
            subjectToDrugTesting: false,
          },
        ]
      : [];
    return {
      legalFirstName: who.first,
      legalMiddleName: null,
      legalLastName: who.last,
      dateOfBirth: `${year - rng.int(28, 52)}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`,
      ssn: `${rng.digits(3)}-${rng.digits(2)}-${rng.digits(4)}`,
      addresses: [
        {
          street: `${rng.int(100, 9900)} ${rng.pick(['Oak', 'Maple', 'Cedar', 'Elm'])} St`,
          city: rng.pick(['Dallas', 'Atlanta', 'Columbus', 'Nashville']),
          state: who.state,
          zip: String(rng.int(30000, 79999)),
          from: `${year - 4}-06-01`,
          to: null,
        },
      ],
      licenses: [
        {
          state: who.state,
          number: String(rng.int(10_000_000, 99_999_999)),
          licenseClass: 'A',
          endorsements: rng.chance(0.5) ? ['H'] : [],
          expiresOn: `${year + rng.int(1, 4)}-0${rng.int(1, 9)}-15`,
        },
      ],
      employment,
      accidents: [],
      convictions: rng.chance(0.4)
        ? [
            {
              date: `${year - 1}-0${rng.int(1, 9)}-12`,
              location: `${who.state}`,
              offense: 'Speeding, 9 over',
              penalty: 'Fine',
            },
          ]
        : [],
      licenseDeniedOrRevoked: false,
      licenseDeniedOrRevokedDetail: null,
      certifiedName: complete ? `${who.first} ${who.last}` : null,
      certifiedOn: complete ? signedOn : null,
    };
  }
}
