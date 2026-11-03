import { Body, ConflictException, Controller, Get, NotFoundException, Param, Put, Query } from '@nestjs/common';
import {
  canReadWorkspaceKey,
  canWriteWorkspaceKey,
  seesCosts,
  stripCostsFromValue,
  workspaceKeyPolicy,
} from '@neway/shared';
import { SignedInOnly } from '../../common/auth/signed-in-only.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { AuditService } from '../people/audit.service';
import { StateService } from './state.service';
import { StolenUnitsService } from './stolen-units.service';

/*
 * The workspace rows, key by key (owner brief, 2026-10-25, finding 1).
 *
 * There is no generic workspace door any more. Every key the API serves is listed in
 * `@neway/shared` workspace/access.ts with the permission codes that read it and the codes that
 * write it; the index answers only the keys the caller may read, a key nobody listed is refused,
 * and maintenance money is taken out of the copy a reader without COST_PERMISSIONS receives. Load
 * prices are served exactly as before (owner, 2026-10-25).
 *
 * Every route reads and writes the caller's own company's workspace only (owner, 2026-10-02).
 */
const PER_KEY = 'per-key policy: @neway/shared workspace/access.ts (read / write codes for every key; unknown keys refused)';

/** The largest single collection a browser may save (the body limit is 30 MB; one key never needs it all). */
const MAX_VALUE_BYTES = 20 * 1024 * 1024;

function forbiddenKey(key: string, verb: 'read' | 'write'): AppError {
  return new AppError({
    status: 403,
    title: 'Forbidden',
    detail: workspaceKeyPolicy(key) === null ? `The workspace has no key '${key}'.` : `You may not ${verb} '${key}'.`,
    extensions: { key },
  });
}

@Controller('state')
export class StateController {
  constructor(
    private readonly state: StateService,
    private readonly stolen: StolenUnitsService,
    private readonly audit: AuditService,
  ) {}

  /** The copy of a row this caller may see: stolen-unit details and maintenance money removed as needed. */
  private async visible<R extends { key: string; value: string }>(principal: Principal, rows: R[]): Promise<R[]> {
    const costs = seesCosts(principal.permissions);
    const stripped = rows.map((row) => {
      const policy = workspaceKeyPolicy(row.key);
      let value = row.value;
      // The Maintenance seat reads repair orders, service records and fuel without their money.
      if (!costs && policy?.stripsCosts) value = stripCostsFromValue(value);
      return value === row.value ? row : { ...row, value };
    });
    // Stolen-unit details reach the administrator role only (owner decision); see stolen-privacy.ts.
    return this.stolen.redactRows(principal, stripped);
  }

  /**
   * The rows under a prefix. Without `keys` it is the index only (key, updatedAt, size) - what a
   * browser polls to notice another browser's writes. With `keys=a,b` it returns those rows with
   * their values in one round trip. Either way only keys the caller may read are answered; a key
   * they may not read is simply absent, as an unknown one always was.
   */
  @Get()
  @SignedInOnly(PER_KEY)
  async index(
    @CurrentPrincipal() principal: Principal,
    @Query('prefix') prefix?: string,
    @Query('keys') keys?: string,
  ): Promise<
    | { key: string; updatedAt: string; bytes: number }[]
    | { key: string; value: string; updatedAt: string }[]
  > {
    if (keys) {
      const wanted = keys
        .split(',')
        .map((k) => k.trim())
        .filter((k) => k && canReadWorkspaceKey(principal.permissions, k));
      if (wanted.length === 0) return [];
      return this.visible(principal, await this.state.getManyFor(principal.companyId, wanted));
    }
    const rows = await this.state.listFor(principal.companyId, String(prefix ?? ''));
    return rows.filter((row) => canReadWorkspaceKey(principal.permissions, row.key));
  }

  @Get(':key')
  @SignedInOnly(PER_KEY)
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
  ): Promise<{ value: string; updatedAt: string }> {
    if (!canReadWorkspaceKey(principal.permissions, key)) throw forbiddenKey(key, 'read');
    const row = await this.state.getFor(principal.companyId, key);
    if (!row) throw new NotFoundException(`No state under '${key}'`);
    const [shown] = await this.visible(principal, [{ key, ...row }]);
    return { value: shown?.value ?? row.value, updatedAt: row.updatedAt };
  }

  /**
   * Stores one collection.
   *
   * Refused (403) unless the key is listed and the caller holds its read and write codes; refused
   * (422) unless the value is JSON of the collection's shape (a list or an object). `ifUnchangedSince`
   * carries the timestamp the caller hydrated from: a write that would bury newer work is refused
   * with 409 rather than applied. Every accepted write is audited (key, size; never the payload).
   */
  @Put(':key')
  @SignedInOnly(PER_KEY)
  async put(
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Body() body: { value?: unknown; ifUnchangedSince?: unknown },
  ): Promise<{ ok: true; updatedAt: string }> {
    if (!canWriteWorkspaceKey(principal.permissions, key)) throw forbiddenKey(key, 'write');
    const value = validateValue(body?.value);
    const ifUnchangedSince = typeof body?.ifUnchangedSince === 'string' ? body.ifUnchangedSince : undefined;
    const updatedAt = await this.state.putFor(
      principal.companyId,
      key,
      // A non-admin holds the redacted copy of the stolen records; writing it back keeps the stored
      // details (the merge in StolenUnitsService), and never wipes them.
      await this.stolen.mergeWrite(principal, key, value),
      ifUnchangedSince,
    );
    if (updatedAt === null) {
      throw new ConflictException(
        'This browser holds an older copy of the workspace. Reload before saving again.',
      );
    }
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'workspace_key',
      entityId: key,
      entityLabel: key,
      summary: `Workspace ${key} saved (${Buffer.byteLength(value)} bytes)`,
    });
    return { ok: true, updatedAt };
  }
}

/** The stored value: a string of JSON whose top level is a list or an object. */
export function validateValue(raw: unknown): string {
  const invalid = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });
  if (typeof raw !== 'string') throw invalid('value must be a JSON string.');
  if (Buffer.byteLength(raw) > MAX_VALUE_BYTES) throw invalid('value is larger than one collection may be.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalid('value is not valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object') throw invalid('value must be a JSON list or object.');
  if (Array.isArray(parsed) && parsed.some((row) => row === null || typeof row !== 'object')) {
    throw invalid('every row in a collection must be an object.');
  }
  return raw;
}
