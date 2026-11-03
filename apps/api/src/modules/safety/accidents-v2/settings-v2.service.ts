import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { accidentsV2 as A, safetyRules as R } from '@neway/shared';
import { hasPermission, type Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import { DatabaseService } from '../../../database/database.service';
import { safetySettings } from '../../../database/schema/accidents-v2';
import { AuditService, type AuditChange } from '../../people/audit.service';
import { SafetyCoreService } from '../safety-core.service';

type DeptAssignees = Partial<Record<R.Dept, { id: string; name: string }>>;
type Insurers = Partial<Record<R.ClaimType, string>>;
const DEDUCTIBLES = ['physicalDamageDeductibleCents', 'autoLiabilityDeductibleCents', 'cargoDeductibleCents'] as const;

/**
 * Accidents settings (go-live, IMPLEMENTATION-PLAN §17 item 8): default assignee per department, default insurer per
 * coverage and the deductibles, kept in `safety_settings` (keys `dept_default_assignee`, `claim_insurers`, `rules`) —
 * the same rows the case and claim services already read. Safety Managers and the owner edit them
 * (`accidents.override`); a save is version-checked (409 when someone saved first) and audited once with before/after.
 */
@Injectable()
export class AccidentSettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly core: SafetyCoreService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private async rows(companyId: string) {
    return this.db.select().from(safetySettings).where(eq(safetySettings.companyId, companyId));
  }

  /** The version is the newest updated_at of the settings rows (null when nothing was ever saved). */
  private static version(rows: { updatedAt: Date }[]): string | null {
    const t = rows.reduce((m, r) => Math.max(m, r.updatedAt.getTime()), 0);
    return t ? new Date(t).toISOString() : null;
  }

  async get(p: Principal): Promise<A.AccidentSettingsResponse> {
    const rows = await this.rows(p.companyId);
    const value = <T>(key: string, fallback: T): T => (rows.find((r) => r.key === key)?.value as T | undefined) ?? fallback;
    const dept = value<DeptAssignees>('dept_default_assignee', {});
    const insurers = value<Insurers>('claim_insurers', {});
    const rules = R.resolveSettings(value<Partial<R.SafetyRuleSettings>>('rules', {}));
    const newest = [...rows].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0];
    return {
      version: AccidentSettingsService.version(rows),
      deptAssignees: Object.fromEntries(A.DEPTS.map((d) => [d, dept[d] ?? null])) as A.AccidentSettingsResponse['deptAssignees'],
      insurers: Object.fromEntries(A.CLAIM_TYPES.map((t) => [t, insurers[t] ?? ''])) as A.AccidentSettingsResponse['insurers'],
      deductibles: {
        physicalDamageDeductibleCents: rules.physicalDamageDeductibleCents,
        autoLiabilityDeductibleCents: rules.autoLiabilityDeductibleCents,
        cargoDeductibleCents: rules.cargoDeductibleCents,
      },
      fallbackDailyContributionCents: rules.fallbackDailyContributionCents,
      people: await this.core.people(p),
      canEdit: hasPermission(p, 'accidents.override'),
      updatedBy: newest?.updatedBy ?? null,
    };
  }

  async put(p: Principal, input: A.AccidentSettingsInput): Promise<A.AccidentSettingsResponse> {
    if (!hasPermission(p, 'accidents.override')) {
      throw new AppError({ status: 403, title: 'Forbidden', type: '/problems/forbidden', detail: 'Accidents settings are kept by Safety Managers and the owner', extensions: { permission: 'accidents.override' } });
    }
    // Resolve every named person before the transaction (a person who is not in the company is refused with 422).
    const people = new Map<string, { id: string; name: string }>();
    for (const id of Object.values(input.deptAssignees ?? {})) {
      if (id && !people.has(id)) {
        const person = await this.core.person(p.companyId, id);
        if (person) people.set(id, person);
      }
    }
    const at = this.core.now();
    const actor = this.core.actor(p);
    const audits = await this.db.transaction(async (tx) => {
      // One lock for the whole settings save of this company, so two saves cannot interleave.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`safety_settings:${p.companyId}`}))`);
      const rows = await tx.select().from(safetySettings).where(eq(safetySettings.companyId, p.companyId));
      const current = AccidentSettingsService.version(rows);
      if (current !== input.version) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          type: '/problems/version-conflict',
          detail: 'Someone saved the Accidents settings after you opened them. Reload them and make your change again.',
          extensions: { currentVersion: current },
        });
      }
      const value = <T>(key: string, fallback: T): T => (rows.find((r) => r.key === key)?.value as T | undefined) ?? fallback;
      const changes: AuditChange[] = [];
      const save = async (key: string, next: unknown) => {
        await tx
          .insert(safetySettings)
          .values({ companyId: p.companyId, key, value: next, updatedBy: actor, updatedAt: at })
          .onConflictDoUpdate({ target: [safetySettings.companyId, safetySettings.key], set: { value: next, updatedBy: actor, updatedAt: at } });
      };

      if (input.deptAssignees) {
        const before = value<DeptAssignees>('dept_default_assignee', {});
        const next: DeptAssignees = { ...before };
        for (const [dept, id] of Object.entries(input.deptAssignees) as [R.Dept, string | null][]) {
          const person = id ? people.get(id) : undefined;
          const old = before[dept]?.name ?? null;
          if (person) next[dept] = person;
          else delete next[dept];
          const now = next[dept]?.name ?? null;
          if (old !== now) changes.push({ field: `deptDefaultAssignee.${dept}`, old, new: now });
        }
        await save('dept_default_assignee', next);
      }
      if (input.insurers) {
        const before = value<Insurers>('claim_insurers', {});
        const next: Insurers = { ...before };
        for (const [type, name] of Object.entries(input.insurers) as [R.ClaimType, string][]) {
          const old = before[type] ?? null;
          if (name.trim()) next[type] = name.trim();
          else delete next[type];
          const now = next[type] ?? null;
          if (old !== now) changes.push({ field: `claimInsurer.${type}`, old, new: now });
        }
        await save('claim_insurers', next);
      }
      if (input.deductibles) {
        const before = value<Partial<R.SafetyRuleSettings>>('rules', {});
        const next: Partial<R.SafetyRuleSettings> = { ...before };
        const resolved = R.resolveSettings(before);
        for (const k of DEDUCTIBLES) {
          const v = input.deductibles[k];
          if (v === undefined) continue;
          if (v !== resolved[k]) changes.push({ field: k, old: String(resolved[k]), new: String(v) });
          next[k] = v;
        }
        await save('rules', next);
      }
      if (!changes.length) return [];
      return [
        await this.audit.writeIn(tx, p, {
          action: 'accident_settings_updated',
          entityType: 'safety_settings',
          entityId: p.companyId,
          entityLabel: 'Accidents settings',
          summary: `Accidents settings changed (${changes.length} ${changes.length === 1 ? 'value' : 'values'})`,
          changes,
          reason: null,
          at,
        }),
      ];
    });
    await this.audit.publish(...audits);
    return this.get(p);
  }
}

