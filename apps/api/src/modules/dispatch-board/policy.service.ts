import { Injectable } from '@nestjs/common';
import { and, desc, eq, lte } from 'drizzle-orm';
import {
  CommissionPolicySchema,
  DEFAULT_POLICY,
  policyProblems,
  previewCommission,
  type CommissionPolicy,
  type CreatePolicyVersionInput,
  type PolicyVersion,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { dispatchPolicyVersions } from '../../database/schema/dispatch-ops';
import { audit, conflict, forbidden, newId, notFound, unprocessable } from './ops.helpers';

type VersionRecord = typeof dispatchPolicyVersions.$inferSelect;

/**
 * Commission policy versions (owner's brief §7–§8). Until a company saves one, DISP-KPI-01 as
 * uploaded is in force. A week reads the latest version effective on or before its Monday, so a
 * new version never rewrites an older week; a finalized salary run keeps its own snapshot anyway.
 */
@Injectable()
export class PolicyService {
  constructor(private readonly database: DatabaseService) {}

  clock: () => Date = () => new Date();

  private get db() {
    return this.database.db;
  }

  private toVersion(r: VersionRecord): PolicyVersion {
    return {
      id: r.id,
      version: r.version,
      effectiveFrom: String(r.effectiveFrom),
      note: r.note,
      policy: CommissionPolicySchema.parse(JSON.parse(r.policy)),
      createdBy: r.createdBy,
      createdByName: r.createdByName,
      createdAt: r.createdAt.toISOString(),
    };
  }

  private builtIn(): PolicyVersion {
    return {
      id: 'built-in',
      version: DEFAULT_POLICY.version,
      effectiveFrom: DEFAULT_POLICY.effectiveFrom,
      note: 'DISP-KPI-01 as uploaded (NWF_Dispatcher_KPI_Updated). Built in until a version is saved.',
      policy: { ...DEFAULT_POLICY, status: 'active' as const, planAdjBasis: DEFAULT_POLICY.planAdjBasis ?? ('seven_day' as const), targetScaling: DEFAULT_POLICY.targetScaling ?? ('display_only' as const) },
      createdBy: 'system',
      createdByName: 'Policy document',
      createdAt: `${DEFAULT_POLICY.effectiveFrom}T00:00:00.000Z`,
    };
  }

  /** The version in force on a date. */
  /**
   * The version that prices a week.
   *
   * Drafts are skipped. A draft is a document an administrator is reading and comparing; writing
   * one down must never change what anybody is paid, and activating one is a separate, deliberate
   * act. The rows are read newest-first and the first active one wins.
   */
  async inForce(companyId: string, date: string): Promise<PolicyVersion> {
    const rows = await this.db
      .select()
      .from(dispatchPolicyVersions)
      .where(and(eq(dispatchPolicyVersions.companyId, companyId), lte(dispatchPolicyVersions.effectiveFrom, date)))
      .orderBy(desc(dispatchPolicyVersions.effectiveFrom), desc(dispatchPolicyVersions.createdAt));
    const active = rows.map((r) => this.toVersion(r)).find((v) => (v.policy.status ?? 'active') === 'active');
    return active ?? this.builtIn();
  }

  /** Every draft on file, for an administrator to read beside the version in force. */
  async drafts(companyId: string): Promise<PolicyVersion[]> {
    const rows = await this.db
      .select()
      .from(dispatchPolicyVersions)
      .where(eq(dispatchPolicyVersions.companyId, companyId))
      .orderBy(desc(dispatchPolicyVersions.createdAt));
    return rows.map((r) => this.toVersion(r)).filter((v) => (v.policy.status ?? 'active') === 'draft');
  }

  /**
   * Activates a draft, from a date forward.
   *
   * A new row is written rather than the draft being edited, so the draft stays readable and the
   * activation has its own author, time and reason. Weeks before `effectiveFrom` keep the version
   * they were priced under, and a finalized salary run keeps its own frozen snapshot either way -
   * activating a policy never rewrites a period that has already been approved or paid.
   */
  async activateDraft(principal: Principal, version: string, input: { effectiveFrom: string; note: string }): Promise<PolicyVersion> {
    this.payEditOrThrow(principal);
    const drafts = await this.drafts(principal.companyId);
    const draft = drafts.find((d) => d.version === version);
    if (!draft) throw notFound(`No draft policy "${version}" on file.`);
    return this.create(principal, {
      version: `${version}-active`,
      effectiveFrom: input.effectiveFrom,
      note: input.note,
      policy: { ...draft.policy, status: 'active', version: `${version}-active`, effectiveFrom: input.effectiveFrom },
    });
  }

  /** Every version, newest first, the built-in document last. */
  async list(companyId: string): Promise<PolicyVersion[]> {
    const rows = await this.db
      .select()
      .from(dispatchPolicyVersions)
      .where(eq(dispatchPolicyVersions.companyId, companyId))
      .orderBy(desc(dispatchPolicyVersions.effectiveFrom), desc(dispatchPolicyVersions.createdAt));
    return [...rows.map((r) => this.toVersion(r)), this.builtIn()];
  }

  validate(policy: CommissionPolicy): string[] {
    const parsed = CommissionPolicySchema.safeParse(policy);
    if (!parsed.success) return parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    return policyProblems(parsed.data);
  }

  preview(policy: CommissionPolicy) {
    return previewCommission(policy);
  }

  /** Commission rules decide what people are paid, so only a company administrator writes one. */
  private payEditOrThrow(principal: Principal): void {
    if (!hasPermission(principal, 'dispatch_pay.edit')) {
      throw forbidden('Changing commission rules takes dispatch_pay.edit (company Administrator).');
    }
  }

  async create(principal: Principal, input: CreatePolicyVersionInput): Promise<PolicyVersion> {
    this.payEditOrThrow(principal);
    const problems = this.validate(input.policy);
    if (problems.length > 0) throw unprocessable(problems.join(' · '));
    const [dup] = await this.db
      .select({ id: dispatchPolicyVersions.id })
      .from(dispatchPolicyVersions)
      .where(and(eq(dispatchPolicyVersions.companyId, principal.companyId), eq(dispatchPolicyVersions.version, input.version)))
      .limit(1);
    if (dup || input.version === DEFAULT_POLICY.version) throw conflict(`Version "${input.version}" already exists; pick a new version label`);
    const now = this.clock();
    const policy: CommissionPolicy = { ...input.policy, version: input.version, effectiveFrom: input.effectiveFrom };
    const row: typeof dispatchPolicyVersions.$inferInsert = {
      id: newId('dpv'),
      companyId: principal.companyId,
      version: input.version,
      effectiveFrom: input.effectiveFrom,
      note: input.note,
      policy: JSON.stringify(policy),
      createdBy: principal.userId,
      createdByName: principal.userName ?? principal.userId,
      createdAt: now,
    };
    const previous = await this.inForce(principal.companyId, input.effectiveFrom);
    await this.db.transaction(async (tx) => {
      await tx.insert(dispatchPolicyVersions).values(row);
      await audit(tx, principal, now, 'policy', row.id, 'create', { version: previous.version }, { version: input.version, effectiveFrom: input.effectiveFrom, note: input.note });
    });
    return this.toVersion({ ...row, note: row.note ?? '', createdByName: row.createdByName ?? '' } as VersionRecord);
  }
}
