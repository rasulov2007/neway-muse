import { Injectable } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import {
  SETTINGS,
  SETTING_DEFAULTS,
  SETTING_SCHEMAS,
  settingDefinition,
  type SettingDefinition,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { settings } from '../../database/schema/admin';
import { companies } from '../../database/schema/roster';
import { AuditService } from '../people/audit.service';

export interface ResolvedSetting extends SettingDefinition {
  value: unknown;
  /** True when nothing has been saved and the shipped default is in effect. */
  isDefault: boolean;
  updatedByName: string | null;
  updatedAt: string | null;
}

/**
 * Company settings.
 *
 * Split storage, on purpose. `company.*` writes to the `companies` row, because that row is what
 * the request principal is built from and what every period resolution in the product reads — the
 * timezone and week start are not decorative preferences, they move the boundaries of every report
 * in Reports, Analytics and the dashboard. Everything else is key/value in `settings`.
 *
 * Values are validated per key against the shared registry before they are written, and a key not
 * in that registry cannot be written at all. A settings table that accepts arbitrary keys becomes a
 * junk drawer whose contents nothing reads.
 */
@Injectable()
export class SettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async all(principal: Principal): Promise<ResolvedSetting[]> {
    const [company] = await this.db
      .select()
      .from(companies)
      .where(eq(companies.id, principal.companyId))
      .limit(1);
    if (!company) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'Company not found' });
    }

    const stored = await this.db
      .select()
      .from(settings)
      .where(eq(settings.companyId, principal.companyId));

    const companyValues: Record<string, unknown> = {
      'company.name': company.name,
      'company.timezone': company.timezone,
      'company.week_start': company.weekStart,
    };

    return SETTINGS.map((definition) => {
      if (definition.storage === 'company') {
        return {
          ...definition,
          value: companyValues[definition.key] ?? null,
          isDefault: false,
          updatedByName: null,
          updatedAt: company.updatedAt.toISOString(),
        };
      }
      const row = stored.find((s) => s.key === definition.key);
      return {
        ...definition,
        value: row ? row.value : (SETTING_DEFAULTS[definition.key] ?? null),
        isDefault: row === undefined,
        updatedByName: row?.updatedByName ?? null,
        updatedAt: row?.updatedAt.toISOString() ?? null,
      };
    });
  }

  /** One value, resolved to its default when unset. Used by the code that enforces a setting. */
  async value<T>(companyId: string, key: string, fallback: T): Promise<T> {
    const [row] = await this.db
      .select({ value: settings.value })
      .from(settings)
      .where(and(eq(settings.companyId, companyId), eq(settings.key, key)))
      .limit(1);
    if (!row) return (SETTING_DEFAULTS[key] as T) ?? fallback;
    return row.value as T;
  }

  async update(principal: Principal, values: Record<string, unknown>): Promise<ResolvedSetting[]> {
    const keys = Object.keys(values);
    if (keys.length === 0) return this.all(principal);

    const unknown = keys.filter((key) => settingDefinition(key) === undefined);
    if (unknown.length > 0) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `Not a setting this system has: ${unknown.join(', ')}`,
      });
    }

    const parsed: Record<string, unknown> = {};
    const errors: { field: string; message: string }[] = [];
    for (const key of keys) {
      const schema = SETTING_SCHEMAS[key];
      if (!schema) {
        errors.push({ field: key, message: 'No validation is defined for this setting' });
        continue;
      }
      const result = schema.safeParse(values[key]);
      if (result.success) parsed[key] = result.data;
      else errors.push({ field: key, message: result.error.issues[0]?.message ?? 'Invalid' });
    }
    if (errors.length > 0) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'One or more settings are not valid',
        extensions: { errors },
      });
    }

    const before = await this.all(principal);
    const actor = principal.userName ?? principal.userId;
    const now = new Date();

    const companyPatch: Record<string, string> = {};
    const keyValueWrites: { key: string; value: unknown }[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      const definition = settingDefinition(key) as SettingDefinition;
      if (definition.storage === 'company') {
        if (key === 'company.name') companyPatch.name = value as string;
        if (key === 'company.timezone') companyPatch.timezone = value as string;
        if (key === 'company.week_start') companyPatch.weekStart = value as string;
      } else {
        keyValueWrites.push({ key, value });
      }
    }

    await this.db.transaction(async (tx) => {
      if (Object.keys(companyPatch).length > 0) {
        await tx
          .update(companies)
          .set({ ...companyPatch, updatedAt: now })
          .where(eq(companies.id, principal.companyId));
      }
      for (const write of keyValueWrites) {
        await tx
          .insert(settings)
          .values({
            companyId: principal.companyId,
            key: write.key,
            value: write.value as object,
            updatedByName: actor,
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [settings.companyId, settings.key],
            set: { value: write.value as object, updatedByName: actor, updatedAt: now },
          });
      }
    });

    const after = await this.all(principal);
    const changes = keys
      .map((key) => ({
        field: key,
        old: this.display(before.find((s) => s.key === key)?.value),
        new: this.display(after.find((s) => s.key === key)?.value),
      }))
      .filter((c) => c.old !== c.new);

    if (changes.length > 0) {
      await this.audit.write(principal, {
        action: 'update',
        entityType: 'settings',
        entityId: principal.companyId,
        entityLabel: 'Company settings',
        summary: `${changes.map((c) => c.field).join(', ')} changed`,
        changes,
      });
    }
    return after;
  }

  private display(value: unknown): string | null {
    if (value === null || value === undefined) return null;
    return typeof value === 'string' ? value : JSON.stringify(value);
  }

  /** Settings that are stored but change nothing yet, named so the screen can say so. */
  notEnforced(): { key: string; label: string; reason: string }[] {
    return SETTINGS.filter((s) => s.enforcedBy === null).map((s) => ({
      key: s.key,
      label: s.label,
      reason: s.notEnforcedReason ?? 'Nothing reads this value yet.',
    }));
  }

  /** Invalidates whatever the principal resolver has cached about this company. */
  async companyRow(companyId: string) {
    const [row] = await this.db.select().from(companies).where(eq(companies.id, companyId)).limit(1);
    return row ?? null;
  }

  /** Bulk read used by the workflow engine, which needs two keys on every event. */
  async valuesFor(companyId: string, keys: string[]): Promise<Record<string, unknown>> {
    const rows = await this.db
      .select({ key: settings.key, value: settings.value })
      .from(settings)
      .where(and(eq(settings.companyId, companyId), inArray(settings.key, keys)));
    const resolved: Record<string, unknown> = {};
    for (const key of keys) {
      const row = rows.find((r) => r.key === key);
      resolved[key] = row ? row.value : SETTING_DEFAULTS[key];
    }
    return resolved;
  }
}
