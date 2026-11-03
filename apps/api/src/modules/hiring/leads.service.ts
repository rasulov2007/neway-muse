import { Inject, Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, or, sql, type SQL } from 'drizzle-orm';
import {
  ApplicationAnswersSchema,
  ApplyAttributionSchema,
  DEFAULT_PREQUALIFICATION_RULES,
  PREQUAL_SETTING_KEYS,
  prequalify,
  phoneMatchKey,
  type Lead,
  type LeadApplication,
  type LeadApplicationSummary,
  type LeadQuery,
  type LeadStatus,
  type LeadSummary,
  type LeadSummaryQuery,
  type Prequalification,
  type PrequalificationRules,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import type { DbExecutor } from '../../database/client';
import {
  hiringApplyLinks,
  hiringCampaigns,
  hiringCases,
  hiringDotApplications,
  hiringLeadApplications,
  hiringLeads,
  type HiringLeadRow,
} from '../../database/schema/hiring';
import { applicants } from '../../database/schema/hr';
import { employees } from '../../database/schema/people';
import { SettingsService } from '../admin/settings.service';
import { CLOCK, type Clock } from '../dashboard/clock';
import { nextNumber, retryOnDuplicate } from '../hr/hr.util';
import { RecruitingService } from '../hr/recruiting.service';
import { AuditService } from '../people/audit.service';
import { HiringService } from './hiring.service';
import { LeadRotationService } from './lead-rotation.service';

/** Every clock in the product is US Eastern (owner, 2026-09-25). */
const EASTERN = 'America/New_York';
const easternDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: EASTERN });

function unprocessable(path: string, message: string): AppError {
  return new AppError({
    status: 422,
    title: 'Unprocessable Entity',
    detail: message,
    extensions: { errors: [{ path, message, code: 'custom' }] },
  });
}

/**
 * Leads: the front of the driver funnel.
 *
 * Three rules this service holds:
 *
 *   - A lead is never deleted. A dead lead keeps its record and, once the ledger exists, its cost.
 *   - Prequalification stores the answers; the verdict is computed from the company's rules each
 *     time and stored beside it with the failed rule named. Changing a rule in Settings changes
 *     what the next evaluation says, and the screen can show *which* rule a lead fails.
 *   - Converting is the only way a lead becomes a candidate, and it requires prequalification.
 *     It creates the recruiting applicant and the hiring case in one transaction, so a lead can
 *     never point at half of a person.
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly settings: SettingsService,
    private readonly recruiting: RecruitingService,
    private readonly hiring: HiringService,
    private readonly audit: AuditService,
    @Inject(CLOCK) private readonly clock: Clock,
    private readonly rotation: LeadRotationService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // =================================================================================== reads

  private async recruiterNames(rows: HiringLeadRow[]): Promise<Map<string, string>> {
    const ids = [
      ...new Set(rows.map((r) => r.recruiterEmployeeId).filter((v): v is string => !!v)),
    ];
    if (ids.length === 0) return new Map();
    const people = await this.db
      .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
      .from(employees)
      .where(sql`${employees.id} in ${ids}`);
    return new Map(people.map((p) => [p.id, `${p.first} ${p.last}`]));
  }

  /**
   * How many online applications each lead has, and the latest one's key answers, in two queries
   * for a whole page rather than two per row.
   */
  private async applicationFacts(
    companyId: string,
    rows: HiringLeadRow[],
  ): Promise<Map<string, { count: number; latest: LeadApplicationSummary }>> {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return new Map();
    const where = and(
      eq(hiringLeadApplications.companyId, companyId),
      inArray(hiringLeadApplications.leadId, ids),
    );
    const counts = await this.db
      .select({ leadId: hiringLeadApplications.leadId, value: count() })
      .from(hiringLeadApplications)
      .where(where)
      .groupBy(hiringLeadApplications.leadId);
    const latest = await this.db
      .selectDistinctOn([hiringLeadApplications.leadId], {
        leadId: hiringLeadApplications.leadId,
        receivedAt: hiringLeadApplications.receivedAt,
        answers: hiringLeadApplications.answers,
        linkName: hiringApplyLinks.name,
      })
      .from(hiringLeadApplications)
      .innerJoin(hiringApplyLinks, eq(hiringApplyLinks.id, hiringLeadApplications.applyLinkId))
      .where(where)
      .orderBy(hiringLeadApplications.leadId, desc(hiringLeadApplications.receivedAt));
    const byLead = new Map(counts.map((c) => [c.leadId, c.value]));
    const out = new Map<string, { count: number; latest: LeadApplicationSummary }>();
    for (const row of latest) {
      // An application stored in an earlier format must not take the list down with it.
      const answers = ApplicationAnswersSchema.safeParse(row.answers);
      out.set(row.leadId, {
        count: byLead.get(row.leadId) ?? 1,
        latest: {
          receivedAt: row.receivedAt.toISOString(),
          linkName: row.linkName,
          experience: answers.success ? answers.data.experience : null,
          position: answers.success ? answers.data.position : null,
        },
      });
    }
    return out;
  }

  private toLead(
    row: HiringLeadRow,
    recruiterName: string | null,
    applications?: { count: number; latest: LeadApplicationSummary },
  ): Lead {
    return {
      id: row.id,
      leadNumber: row.leadNumber,
      firstName: row.firstName,
      lastName: row.lastName,
      // A one-word name (an online applicant may give only one) has an empty last name.
      name: `${row.firstName} ${row.lastName}`.trim(),
      phone: row.phone,
      email: row.email,
      cdlClass: row.cdlClass as Lead['cdlClass'],
      state: row.state,
      yearsExperience: row.yearsExperience === null ? null : Number(row.yearsExperience),
      source: row.source as Lead['source'],
      campaignId: row.campaignId,
      recruiterEmployeeId: row.recruiterEmployeeId,
      recruiterName,
      notes: row.notes,
      status: row.status as LeadStatus,
      prequalification: (row.prequalification as Prequalification | null) ?? null,
      prequalResult: (row.prequalResult as Lead['prequalResult']) ?? null,
      applicantId: row.applicantId,
      hiringCaseId: row.hiringCaseId,
      deadReason: row.deadReason,
      applicationCount: applications?.count ?? 0,
      lastAppliedAt: row.lastAppliedAt?.toISOString() ?? null,
      latestApplication: applications?.latest ?? null,
      createdAt: row.createdAt.toISOString(),
      contactedAt: row.contactedAt?.toISOString() ?? null,
      prequalifiedAt: row.prequalifiedAt?.toISOString() ?? null,
      convertedAt: row.convertedAt?.toISOString() ?? null,
      deadAt: row.deadAt?.toISOString() ?? null,
    };
  }

  private flaggedCondition() {
    // Prequalified against the rules and failed at least one, and not yet disqualified.
    return sql`${hiringLeads.prequalResult} is not null and (${hiringLeads.prequalResult}->>'qualifies') = 'false' and ${hiringLeads.status} <> 'dead'`;
  }

  /** The Eastern business date a lead was added on (every clock in the product is Eastern). */
  private addedOn() {
    return sql`(${hiringLeads.createdAt} at time zone ${EASTERN})::date`;
  }

  private periodParts(query: { from?: string; to?: string }) {
    const parts = [];
    if (query.from) parts.push(sql`${this.addedOn()} >= ${query.from}::date`);
    if (query.to) parts.push(sql`${this.addedOn()} <= ${query.to}::date`);
    return parts;
  }

  async list(
    principal: Principal,
    query: LeadQuery,
  ): Promise<{ data: Lead[]; total: number; page: number; pageSize: number }> {
    // Test leads are kept but never listed (owner, 2026-10-07).
    const parts = [
      eq(hiringLeads.companyId, principal.companyId),
      eq(hiringLeads.isTest, false),
      ...this.periodParts(query),
    ];
    if (query.status) parts.push(eq(hiringLeads.status, query.status));
    if (query.source) parts.push(eq(hiringLeads.source, query.source));
    if (query.campaignId) parts.push(eq(hiringLeads.campaignId, query.campaignId));
    if (query.recruiterEmployeeId) {
      parts.push(eq(hiringLeads.recruiterEmployeeId, query.recruiterEmployeeId));
    }
    if (query.flagged) parts.push(this.flaggedCondition());
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(hiringLeads.firstName, term),
        ilike(hiringLeads.lastName, term),
        ilike(hiringLeads.phone, term),
        ilike(hiringLeads.email, term),
        ilike(hiringLeads.leadNumber, term),
      );
      if (match) parts.push(match);
    }
    const where = and(...parts);
    const [counted] = await this.db.select({ value: count() }).from(hiringLeads).where(where);
    const direction = query.dir === 'asc' ? asc : desc;
    // `dir` is a validated enum, so it is safe as raw SQL; blanks sort last either way.
    const nulls = sql`nulls last`;
    const order = {
      name: [direction(hiringLeads.lastName), direction(hiringLeads.firstName)],
      status: [direction(hiringLeads.status)],
      source: [direction(hiringLeads.source)],
      cdlClass: [sql`${hiringLeads.cdlClass} ${sql.raw(query.dir)} ${nulls}`],
      yearsExperience: [sql`${hiringLeads.yearsExperience} ${sql.raw(query.dir)} ${nulls}`],
      recruiter: [sql`${employees.lastName} ${sql.raw(query.dir)} ${nulls}`, sql`${employees.firstName} ${sql.raw(query.dir)}`],
      createdAt: [direction(hiringLeads.createdAt)],
    }[query.sort];
    const rows = (
      await this.db
        .select({ lead: hiringLeads })
        .from(hiringLeads)
        .leftJoin(employees, eq(employees.id, hiringLeads.recruiterEmployeeId))
        .where(where)
        .orderBy(...order, desc(hiringLeads.createdAt), asc(hiringLeads.id))
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
    ).map((r) => r.lead);
    const names = await this.recruiterNames(rows);
    const facts = await this.applicationFacts(principal.companyId, rows);
    return {
      data: rows.map((row) =>
        this.toLead(row, names.get(row.recruiterEmployeeId ?? '') ?? null, facts.get(row.id)),
      ),
      total: counted?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(principal: Principal, id: string): Promise<Lead> {
    const [row] = await this.db
      .select()
      .from(hiringLeads)
      .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No lead ${id}` });
    const names = await this.recruiterNames([row]);
    const facts = await this.applicationFacts(principal.companyId, [row]);
    return this.toLead(row, names.get(row.recruiterEmployeeId ?? '') ?? null, facts.get(row.id));
  }

  /** Every online application on file for one lead, newest first. */
  async applications(principal: Principal, id: string): Promise<LeadApplication[]> {
    await this.get(principal, id);
    const rows = await this.db
      .select({
        application: hiringLeadApplications,
        link: { id: hiringApplyLinks.id, slug: hiringApplyLinks.slug, name: hiringApplyLinks.name },
        campaignName: hiringCampaigns.name,
      })
      .from(hiringLeadApplications)
      .innerJoin(hiringApplyLinks, eq(hiringApplyLinks.id, hiringLeadApplications.applyLinkId))
      .leftJoin(hiringCampaigns, eq(hiringCampaigns.id, hiringLeadApplications.campaignId))
      .where(
        and(
          eq(hiringLeadApplications.companyId, principal.companyId),
          eq(hiringLeadApplications.leadId, id),
        ),
      )
      .orderBy(desc(hiringLeadApplications.receivedAt));
    return rows.map(({ application: a, link, campaignName }) => ({
      id: a.id,
      leadId: a.leadId,
      receivedAt: a.receivedAt.toISOString(),
      outcome: a.outcome as LeadApplication['outcome'],
      link,
      source: a.source,
      campaignId: a.campaignId,
      campaignName: campaignName ?? null,
      // An earlier-format row reads as null ("Answers in an earlier format"), never a crash.
      answers: ApplicationAnswersSchema.safeParse(a.answers).data ?? null,
      attribution: ApplyAttributionSchema.safeParse(a.attribution).data ?? {
        utmSource: null,
        utmMedium: null,
        utmCampaign: null,
        utmTerm: null,
        utmContent: null,
        fbclid: null,
        gclid: null,
        referrer: null,
      },
      consent: {
        text: a.consentText,
        privacyPolicyUrl: a.privacyPolicyUrl,
        agreedAt: a.consentedAt.toISOString(),
      },
    }));
  }

  // ============================================================ the duplicate-candidate rule

  /**
   * A phone number as the duplicate rule compares it: digits only, North American numbers with
   * their country code. The TypeScript twin is `phoneMatchKey` in @neway/shared.
   */
  static phoneKeySql(column: typeof hiringLeads.phone): SQL<string> {
    const digits = sql`regexp_replace(${column}, '\\D', '', 'g')`;
    return sql<string>`(case when length(${digits}) = 10 then '1' || ${digits} else ${digits} end)`;
  }

  /**
   * The one duplicate rule, used by a recruiter adding a lead and by the online application alike:
   * a company already has this person when a lead with the same phone number exists and is not
   * dead. A converted lead counts — the person is a candidate already.
   */
  async findOpenLeadByPhone(
    db: DbExecutor,
    companyId: string,
    phone: string,
  ): Promise<{ id: string; number: string; status: string } | null> {
    const [dup] = await db
      .select({ id: hiringLeads.id, number: hiringLeads.leadNumber, status: hiringLeads.status })
      .from(hiringLeads)
      .where(
        and(
          eq(hiringLeads.companyId, companyId),
          sql`${LeadsService.phoneKeySql(hiringLeads.phone)} = ${phoneMatchKey(phone)}`,
          sql`${hiringLeads.status} <> 'dead'`,
          eq(hiringLeads.isTest, false),
        ),
      )
      .orderBy(asc(hiringLeads.createdAt))
      .limit(1);
    return dup ?? null;
  }

  /**
   * The count tiles, over the leads added in the period (all leads when no period is given).
   * Every tile is a subset of the same cohort, so "converted" reads "of the leads added in this
   * period, how many became candidates". "New today" is the Eastern today, not the server's.
   */
  async summary(principal: Principal, query: LeadSummaryQuery = {}): Promise<LeadSummary> {
    const today = easternDate(this.clock());
    const [row] = await this.db
      .select({
        total: count(),
        newToday: sql<number>`count(*) filter (where ${this.addedOn()} = ${today}::date)::int`,
        uncontacted: sql<number>`count(*) filter (where ${hiringLeads.status} = 'new')::int`,
        contacted: sql<number>`count(*) filter (where ${hiringLeads.status} = 'contacted')::int`,
        prequalified: sql<number>`count(*) filter (where ${hiringLeads.status} = 'prequalified')::int`,
        flagged: sql<number>`count(*) filter (where ${this.flaggedCondition()})::int`,
        converted: sql<number>`count(*) filter (where ${hiringLeads.status} = 'converted')::int`,
        dead: sql<number>`count(*) filter (where ${hiringLeads.status} = 'dead')::int`,
      })
      .from(hiringLeads)
      .where(
        and(
          eq(hiringLeads.companyId, principal.companyId),
          eq(hiringLeads.isTest, false),
          ...this.periodParts(query),
        ),
      );
    return {
      total: row?.total ?? 0,
      newToday: row?.newToday ?? 0,
      uncontacted: row?.uncontacted ?? 0,
      contacted: row?.contacted ?? 0,
      prequalified: row?.prequalified ?? 0,
      flagged: row?.flagged ?? 0,
      converted: row?.converted ?? 0,
      dead: row?.dead ?? 0,
      dotReviews: await this.dotReviews(principal.companyId),
    };
  }

  /** Applications a driver certified through the link that no recruiter has accepted or returned yet. */
  private async dotReviews(companyId: string): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(hiringDotApplications)
      .innerJoin(hiringCases, eq(hiringCases.id, hiringDotApplications.hiringCaseId))
      .where(
        and(
          eq(hiringDotApplications.companyId, companyId),
          eq(hiringDotApplications.status, 'driver_submitted'),
          eq(hiringCases.isTest, false),
        ),
      );
    return row?.value ?? 0;
  }

  /** The rules in force, from Settings, with the shipped defaults where nothing was set. */
  async rules(companyId: string): Promise<PrequalificationRules> {
    const v = await this.settings.valuesFor(companyId, Object.values(PREQUAL_SETTING_KEYS));
    const num = (key: string, fallback: number | null): number | null => {
      const value = v[key];
      if (value === null) return null;
      return typeof value === 'number' ? value : fallback;
    };
    const bool = (key: string, fallback: boolean): boolean =>
      typeof v[key] === 'boolean' ? (v[key] as boolean) : fallback;
    const d = DEFAULT_PREQUALIFICATION_RULES;
    return {
      requireAge23: bool(PREQUAL_SETTING_KEYS.requireAge23, d.requireAge23),
      minCdlYears: num(PREQUAL_SETTING_KEYS.minCdlYears, d.minCdlYears),
      minExperienceYears: num(PREQUAL_SETTING_KEYS.minExperienceYears, d.minExperienceYears),
      maxAccidents36mo: num(PREQUAL_SETTING_KEYS.maxAccidents36mo, d.maxAccidents36mo),
      maxViolations36mo: num(PREQUAL_SETTING_KEYS.maxViolations36mo, d.maxViolations36mo),
      duiDisqualifies: bool(PREQUAL_SETTING_KEYS.duiDisqualifies, d.duiDisqualifies),
    };
  }

  // ================================================================================== writes

  async create(
    principal: Principal,
    input: {
      firstName: string;
      lastName: string;
      phone: string;
      email: string | null;
      cdlClass: string | null;
      state: string | null;
      yearsExperience: number | null;
      source: string;
      campaignId: string | null;
      recruiterEmployeeId: string | null;
      notes: string | null;
    },
  ): Promise<Lead> {
    const dup = await this.findOpenLeadByPhone(this.db, principal.companyId, input.phone);
    if (dup) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `That phone number is already lead ${dup.number} (${dup.status}). Open it rather than starting a second record.`,
        extensions: {
          errors: [{ path: 'phone', message: `Already lead ${dup.number}`, code: 'custom' }],
        },
      });
    }
    await this.assertReferences(principal, input);
    // A recruiter named on the form wins; otherwise the lead takes the next turn in the HR
    // rotation, the same one online applications take (owner, 2026-10-08: Add lead is automatic
    // by default). With nobody eligible the lead arrives unassigned and Recruiting settings says so.
    const chosen = input.recruiterEmployeeId;
    const { id } = await retryOnDuplicate(() => this.db.transaction(async (tx) => {
      const leadNumber = await nextNumber(
        tx,
        hiringLeads,
        hiringLeads.leadNumber,
        hiringLeads.companyId,
        principal.companyId,
        'LEAD',
        1000,
      );
      // Globally unique: the number is per company, and two companies' numbers must not share an id.
      const id = `lead_${crypto.randomUUID()}`;
      const recruiterId =
        chosen ??
        (
          await this.rotation.assignNext(
            tx,
            principal.companyId,
            { id, label: `${input.firstName} ${input.lastName}`.trim() },
            { id: principal.userId, name: principal.userName ?? principal.userId, type: 'user' },
            'manual',
          )
        )?.employeeId ??
        null;
      await tx.insert(hiringLeads).values({
        id,
        companyId: principal.companyId,
        leadNumber,
        firstName: input.firstName,
        lastName: input.lastName,
        phone: input.phone,
        email: input.email,
        cdlClass: input.cdlClass,
        state: input.state,
        yearsExperience: input.yearsExperience === null ? null : String(input.yearsExperience),
        source: input.source,
        campaignId: input.campaignId,
        recruiterEmployeeId: recruiterId,
        notes: input.notes,
        status: 'new',
      });
      return { id };
    }));
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'lead',
      entityId: id,
      entityLabel: `${input.firstName} ${input.lastName}`,
      summary: `Lead added from ${input.source.replace(/_/g, ' ')}`,
    });
    return this.get(principal, id);
  }

  /**
   * A campaign and a recruiter named on a lead must be this company's. Neither column is a
   * company-checked key, so without this a lead could be attributed to another tenant's campaign.
   */
  private async assertReferences(
    principal: Principal,
    input: { campaignId?: string | null; recruiterEmployeeId?: string | null },
  ): Promise<void> {
    if (input.campaignId) {
      const [campaign] = await this.db
        .select({ id: hiringCampaigns.id })
        .from(hiringCampaigns)
        .where(
          and(
            eq(hiringCampaigns.companyId, principal.companyId),
            eq(hiringCampaigns.id, input.campaignId),
          ),
        )
        .limit(1);
      if (!campaign) throw unprocessable('campaignId', 'No such campaign in this company');
    }
    if (input.recruiterEmployeeId) {
      const [person] = await this.db
        .select({ status: employees.status })
        .from(employees)
        .where(
          and(
            eq(employees.companyId, principal.companyId),
            eq(employees.id, input.recruiterEmployeeId),
          ),
        )
        .limit(1);
      if (!person) throw unprocessable('recruiterEmployeeId', 'No such employee in this company');
      if (person.status === 'terminated') {
        throw unprocessable('recruiterEmployeeId', 'That employee has left the company');
      }
    }
  }

  async update(
    principal: Principal,
    id: string,
    patch: Partial<Parameters<LeadsService['create']>[1]>,
  ): Promise<Lead> {
    const before = await this.get(principal, id);
    if (before.status === 'converted') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'This lead has become a candidate; edit the candidate record instead.',
      });
    }
    await this.assertReferences(principal, patch);
    await this.db
      .update(hiringLeads)
      .set({
        firstName: patch.firstName,
        lastName: patch.lastName,
        phone: patch.phone,
        email: patch.email,
        cdlClass: patch.cdlClass,
        state: patch.state,
        yearsExperience:
          patch.yearsExperience === undefined
            ? undefined
            : patch.yearsExperience === null
              ? null
              : String(patch.yearsExperience),
        source: patch.source,
        campaignId: patch.campaignId,
        recruiterEmployeeId: patch.recruiterEmployeeId,
        notes: patch.notes,
        updatedAt: new Date(),
      })
      .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, id)));
    const after = await this.get(principal, id);
    const fields = [
      'firstName',
      'lastName',
      'phone',
      'email',
      'cdlClass',
      'state',
      'yearsExperience',
      'source',
      'campaignId',
      'recruiterEmployeeId',
      'notes',
    ] as const;
    const changes = fields
      .filter((f) => patch[f] !== undefined && String(before[f] ?? '') !== String(after[f] ?? ''))
      .map((f) => ({
        field: f,
        old: before[f] === null ? null : String(before[f]),
        new: after[f] === null ? null : String(after[f]),
      }));
    if (changes.length > 0) {
      const recruiterOnly = changes.length === 1 && changes[0]?.field === 'recruiterEmployeeId';
      await this.audit.write(principal, {
        action: recruiterOnly ? 'assign' : 'update',
        entityType: 'lead',
        entityId: id,
        entityLabel: after.name,
        summary: recruiterOnly
          ? after.recruiterName
            ? `Recruiter set to ${after.recruiterName}`
            : 'Recruiter removed'
          : `Lead updated: ${changes.map((c) => c.field).join(', ')}`,
        changes,
      });
    }
    return after;
  }

  /**
   * Marks a lead as test data (owner, 2026-10-07): it stays in the database and its audit trail,
   * and leaves every list, count, phone dedupe and analytics. Nothing is deleted.
   */
  async markTest(principal: Principal, id: string, reason: string): Promise<void> {
    const before = await this.get(principal, id);
    const at = new Date();
    await this.db
      .update(hiringLeads)
      .set({
        isTest: true,
        testMarkedAt: at,
        testMarkedBy: principal.userName ?? principal.userId,
        testReason: reason,
        updatedAt: at,
      })
      .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, id)));
    await this.audit.write(principal, {
      action: 'mark_test',
      entityType: 'lead',
      entityId: id,
      entityLabel: before.name,
      summary: `Lead ${before.leadNumber} marked as test data and hidden`,
      reason,
      changes: [{ field: 'isTest', old: 'false', new: 'true' }],
      at,
    });
  }

  /**
   * Called, nobody answered (owner, 2026-10-12). Each attempt is its own audit line, so the lead
   * says how many times it was tried; the first time moves it out of New.
   */
  async markNoAnswer(principal: Principal, id: string): Promise<Lead> {
    const before = await this.get(principal, id);
    if (before.status !== 'new' && before.status !== 'no_answer') return before;
    const at = new Date();
    await this.db.update(hiringLeads).set({ status: 'no_answer', updatedAt: at }).where(eq(hiringLeads.id, id));
    await this.audit.write(principal, {
      action: before.status === 'new' ? 'status_change' : 'contact_attempt',
      entityType: 'lead',
      entityId: id,
      entityLabel: before.name,
      summary: 'Called — no answer',
      changes: before.status === 'new' ? [{ field: 'status', old: 'new', new: 'no_answer' }] : [],
      at,
    });
    return this.get(principal, id);
  }

  async markContacted(principal: Principal, id: string): Promise<Lead> {
    const before = await this.get(principal, id);
    if (before.status !== 'new' && before.status !== 'no_answer') return before;
    const at = new Date();
    await this.db
      .update(hiringLeads)
      .set({ status: 'contacted', contactedAt: at, updatedAt: at })
      .where(eq(hiringLeads.id, id));
    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'lead',
      entityId: id,
      entityLabel: before.name,
      summary: 'Lead contacted',
      changes: [{ field: 'status', old: before.status, new: 'contacted' }],
      at,
    });
    return this.get(principal, id);
  }

  /**
   * Records the answers and evaluates them against the rules in force.
   *
   * A lead that passes moves to `prequalified`. One that fails stays where it is with the failed
   * rules stored beside the answers — flagged, not disqualified, because the recruiter decides
   * that with a click and a reason. Re-recording after a rule change re-evaluates.
   */
  async prequalify(principal: Principal, id: string, answers: Prequalification): Promise<Lead> {
    const before = await this.get(principal, id);
    if (before.status === 'converted' || before.status === 'dead') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `A ${before.status} lead cannot be prequalified`,
      });
    }
    const rules = await this.rules(principal.companyId);
    const result = prequalify(answers, rules);
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    await this.db
      .update(hiringLeads)
      .set({
        prequalification: { ...answers, recordedAt: at.toISOString(), recordedBy: by },
        prequalResult: { ...result, evaluatedAt: at.toISOString() },
        status: result.qualifies
          ? 'prequalified'
          : before.status === 'new'
            ? 'contacted'
            : before.status,
        contactedAt: before.contactedAt ? new Date(before.contactedAt) : at,
        prequalifiedAt: result.qualifies ? at : null,
        updatedAt: at,
      })
      .where(eq(hiringLeads.id, id));
    await this.audit.write(principal, {
      action: result.qualifies ? 'status_change' : 'update',
      entityType: 'lead',
      entityId: id,
      entityLabel: before.name,
      summary: result.qualifies
        ? 'Prequalified'
        : `Does not prequalify: ${result.failed.map((f) => f.label).join(', ')}`,
      changes: result.qualifies
        ? [{ field: 'status', old: before.status, new: 'prequalified' }]
        : result.failed.map((f) => ({ field: f.rule, old: null, new: f.detail })),
      at,
    });
    return this.get(principal, id);
  }

  async disqualify(principal: Principal, id: string, reason: string): Promise<Lead> {
    const before = await this.get(principal, id);
    if (before.status === 'converted') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'This lead has become a candidate; disqualify the candidate instead.',
      });
    }
    if (before.status === 'dead') return before;
    const at = new Date();
    await this.db
      .update(hiringLeads)
      .set({ status: 'dead', deadAt: at, deadReason: reason, updatedAt: at })
      .where(eq(hiringLeads.id, id));
    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'lead',
      entityId: id,
      entityLabel: before.name,
      summary: `Lead disqualified`,
      changes: [{ field: 'status', old: before.status, new: 'dead' }],
      reason,
      at,
    });
    return this.get(principal, id);
  }

  /**
   * Brings a disqualified lead back (owner, 2026-10-09), with a note saying why. The lead returns to
   * the step it had reached - Prequalified when its answers passed, else Contacted, else New - and
   * the disqualification is cleared. One transaction: the status change (audited) and the note (on
   * the Notes tab) commit together.
   */
  async reopen(principal: Principal, id: string, note: string): Promise<Lead> {
    const before = await this.get(principal, id);
    if (before.status !== 'dead') {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'Only a disqualified lead can be reopened.' });
    }
    const status = before.prequalResult?.qualifies ? 'prequalified' : before.contactedAt ? 'contacted' : 'new';
    const at = new Date();
    const events = await this.db.transaction(async (tx) => {
      await tx
        .update(hiringLeads)
        .set({ status, deadAt: null, deadReason: null, updatedAt: at })
        .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, id)));
      return [
        await this.audit.writeIn(tx, principal, {
          action: 'status_change',
          entityType: 'lead',
          entityId: id,
          entityLabel: before.name,
          summary: `Lead reopened (was disqualified: ${before.deadReason ?? 'no reason'})`,
          changes: [{ field: 'status', old: 'dead', new: status }],
          reason: note,
          at,
        }),
        await this.audit.writeIn(tx, principal, {
          action: 'note',
          entityType: 'hiring_lead',
          entityId: id,
          entityLabel: before.name,
          summary: 'Note added (lead reopened)',
          reason: note,
          changes: [],
          at,
        }),
      ];
    });
    await this.audit.publish(...events);
    return this.get(principal, id);
  }

  /**
   * Converts a prequalified lead into a candidate: the recruiting applicant and the hiring case,
   * in one transaction, with the lead pointing at both afterwards.
   */
  async convert(principal: Principal, id: string, options: { byApplication?: boolean } = {}): Promise<Lead> {
    // One conversion per lead at a time: a double click or a retry waits here, then finds the
    // lead converted (or half-way, and finishes it) instead of opening a second candidate.
    return this.hiring.withLock(`lead-convert:${principal.companyId}:${id}`, () =>
      this.convertOnce(principal, id, options),
    );
  }

  /**
   * Resumable: every piece it creates is written back to the lead as soon as it exists, so an
   * attempt that failed half-way (applicant made, case not yet) is finished by the retry, never
   * repeated.
   */
  private async convertOnce(principal: Principal, id: string, options: { byApplication?: boolean }): Promise<Lead> {
    const before = await this.get(principal, id);
    if (before.status === 'converted') return before;
    // The driver submitted the application through their personal link (owner, 2026-10-08): the
    // application itself is what makes them a candidate, prequalified or not.
    const byApplication = Boolean(options.byApplication);
    if (byApplication && before.status === 'dead') {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'This lead was disqualified.' });
    }
    if (!byApplication && before.status !== 'prequalified') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail:
          before.prequalResult && !before.prequalResult.qualifies
            ? `Does not prequalify: ${before.prequalResult.failed.map((f) => f.label).join(', ')}. Disqualify the lead, or correct the answers and re-evaluate.`
            : 'Prequalify the lead before converting it.',
      });
    }
    const at = new Date();
    // Applicants require an email; a lead may not have given one. The placeholder is explicit
    // and unique, and the applicant record says so until a real address replaces it.
    let email = (before.email ?? `${before.leadNumber.toLowerCase()}@no-email.lead`).toLowerCase();
    /** Said on the new candidate when its email had to stand aside for an earlier one. */
    let emailNote: string | null = null;

    let applicantId = before.applicantId;
    let applicantNumber: string | null = null;
    if (!applicantId) {
      // An earlier attempt may have created the applicant and failed before recording it.
      const [earlier] = await this.db
        .select({ id: applicants.id, number: applicants.applicantNumber, phone: applicants.phone })
        .from(applicants)
        .where(
          and(eq(applicants.companyId, principal.companyId), sql`lower(${applicants.email}) = ${email}`),
        )
        .limit(1);
      if (earlier && earlier.phone.replace(/\D/g, '') !== before.phone.replace(/\D/g, '')) {
        if (!byApplication) {
          throw new AppError({
            status: 409,
            title: 'Conflict',
            detail: `${email} already belongs to candidate ${earlier.number}. Correct the lead's email, or open that candidate.`,
          });
        }
        /*
         * The driver has already signed (owner, 2026-10-13: a consent failed on exactly this). Their
         * paperwork is never refused over a clash in our records: the candidate is filed with a
         * placeholder email and Recruiting is told which earlier candidate holds the address.
         */
        emailNote = `Email ${email} already belongs to candidate ${earlier.number} (phone ${earlier.phone}); filed with a placeholder email. Check whether this is the same driver.`;
        email = `${before.leadNumber.toLowerCase()}@no-email.lead`;
      }
      // A retry after the placeholder candidate was made but not recorded finds that one again.
      const [placeholder] = emailNote
        ? await this.db
            .select({ id: applicants.id, number: applicants.applicantNumber })
            .from(applicants)
            .where(and(eq(applicants.companyId, principal.companyId), sql`lower(${applicants.email}) = ${email}`))
            .limit(1)
        : [];
      const reuse = emailNote ? placeholder : earlier;
      if (reuse) {
        applicantId = reuse.id;
        applicantNumber = reuse.number;
      } else {
        const applicant = await this.recruiting.createApplicant(principal, {
          firstName: before.firstName,
          lastName: before.lastName,
          email,
          phone: before.phone,
          position: 'Driver',
          department: 'dispatch',
          jobOpeningId: null,
          location: before.state,
          source: before.source,
          assignedRecruiterEmployeeId: before.recruiterEmployeeId,
          driverType: before.prequalification?.payTypePreference ?? null,
          appliedOn: easternDate(at),
          notes: [before.notes, emailNote].filter(Boolean).join('\n') || null,
        });
        applicantId = applicant.id;
        if (emailNote) {
          await this.audit.write(principal, {
            action: 'candidate_email_clash',
            entityType: 'lead',
            entityId: id,
            entityLabel: before.name,
            summary: emailNote,
          });
        }
        applicantNumber = applicant.applicantNumber;
      }
      await this.db
        .update(hiringLeads)
        .set({ applicantId, updatedAt: at })
        .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, id)));
    }
    if (!applicantNumber) {
      applicantNumber = (await this.recruiting.getApplicant(principal, applicantId)).applicantNumber;
    }

    let caseId = before.hiringCaseId;
    if (!caseId) {
      const [open] = await this.db
        .select({ id: hiringCases.id })
        .from(hiringCases)
        .where(
          and(
            eq(hiringCases.companyId, principal.companyId),
            eq(hiringCases.applicantId, applicantId),
          ),
        )
        .limit(1);
      caseId =
        open?.id ??
        (await this.hiring.openForApplicant(principal, {
          applicantId,
          candidateName: before.name,
          recruiterId: before.recruiterEmployeeId,
          recruiterName: before.recruiterName,
          history: [
            {
              state: 'lead',
              at: new Date(before.createdAt),
              byName: before.recruiterName ?? 'Recruiting',
            },
            // A lead that applied before it was prequalified skips that stage; the history says
            // so rather than inventing a prequalification.
            ...(before.status === 'prequalified' || before.prequalifiedAt
              ? [
                  {
                    state: 'prequalified' as const,
                    at: new Date(before.prequalifiedAt ?? before.createdAt),
                    byName: before.prequalification?.recordedBy ?? before.recruiterName ?? 'Recruiting',
                  },
                ]
              : []),
            {
              state: 'application',
              at,
              byName: byApplication ? `${before.name} (personal application link)` : (principal.userName ?? principal.userId),
            },
          ],
        }));
    }
    await this.db
      .update(hiringLeads)
      .set({
        status: 'converted',
        convertedAt: at,
        applicantId,
        hiringCaseId: caseId,
        updatedAt: at,
      })
      .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, id)));
    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'lead',
      entityId: id,
      entityLabel: before.name,
      summary: byApplication
        ? `Converted to candidate ${applicantNumber}: the driver submitted the application through their personal link`
        : `Converted to candidate ${applicantNumber}`,
      changes: [{ field: 'status', old: before.status, new: 'converted' }],
      at,
    });
    return this.get(principal, id);
  }
}
