import { Injectable } from '@nestjs/common';
import { LEGACY_WORKSPACE_KEY, WORKSPACE_PREFIX } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { StateService } from './state.service';
import {
  COMPLIANCE_AUDIT_KEY,
  TRUCK_NOTES_KEY,
  hidesTruckNote,
  redactTruckNotes,
  truckNoteKey,
  EMPTY_STOLEN_CONTEXT,
  UNIT_EXITS_KEY,
  exitKey,
  hidesWorkspaceAudit,
  isStolenRecord,
  mergeProtected,
  redactAuditLogs,
  redactExits,
  redactWorkspaceAudit,
  seesStolenDetails,
  stolenContextFrom,
  workspaceAuditKey,
  type AuditLineLike,
  type StolenContext,
} from './stolen-privacy';

/** The workspace keys whose values carry stolen details. */
const GUARDED_KEYS = new Set([UNIT_EXITS_KEY, COMPLIANCE_AUDIT_KEY, TRUCK_NOTES_KEY, LEGACY_WORKSPACE_KEY]);

/**
 * Which units are stolen, and what a given principal may see of them (see `stolen-privacy.ts`).
 *
 * The exit records live in the workspace (`ws2-unitexits`), written by the browser; this reads the
 * stored copy - never a redacted one - so the rule always works from the full account.
 */
@Injectable()
export class StolenUnitsService {
  constructor(private readonly state: StateService) {}

  seesDetails(principal: Principal): boolean {
    return seesStolenDetails(principal);
  }

  /** The company's stolen units, whoever is asking. */
  async contextFor(companyId: string): Promise<StolenContext> {
    return stolenContextFrom(await this.storedExits(companyId));
  }

  /** The context a read must apply, or null when this principal sees everything. */
  async restrictionsFor(principal: Principal): Promise<StolenContext | null> {
    if (seesStolenDetails(principal)) return null;
    return this.contextFor(principal.companyId);
  }

  /** Unit ids whose location, notes and documents a non-admin does not receive. */
  async hiddenUnits(principal: Principal): Promise<Set<string>> {
    const context = await this.restrictionsFor(principal);
    return context ? context.current : EMPTY_STOLEN_CONTEXT.current;
  }

  /** Audit lines with stolen details replaced by "Restricted (stolen unit)" for a non-admin. */
  async redactAuditLines<T extends AuditLineLike>(principal: Principal, rows: T[]): Promise<T[]> {
    const context = await this.restrictionsFor(principal);
    return context ? redactAuditLogs(context, rows) : rows;
  }

  /**
   * Compliance audit lines (`ComplianceAuditEntry`, the same shape as the workspace's): subject,
   * before, after and reason blanked on a line about a stolen unit, for a non-admin.
   */
  async redactComplianceEntries<T>(principal: Principal, entries: T[]): Promise<T[]> {
    const context = await this.restrictionsFor(principal);
    return context ? (redactWorkspaceAudit(context, entries) as T[]) : entries;
  }

  /** Documents whose owner is a stolen unit are withheld from a non-admin entirely. */
  async visibleDocuments<T extends { ownerId: string }>(principal: Principal, documents: T[]): Promise<T[]> {
    const hidden = await this.hiddenUnits(principal);
    return hidden.size === 0 ? documents : documents.filter((doc) => !hidden.has(doc.ownerId));
  }

  isGuardedKey(key: string): boolean {
    return GUARDED_KEYS.has(key);
  }

  // ------------------------------------------------------------------------------ /state reads

  /** The rows as this principal may read them. Rows for other keys pass through untouched. */
  async redactRows<R extends { key: string; value: string }>(principal: Principal, rows: R[]): Promise<R[]> {
    if (seesStolenDetails(principal) || !rows.some((row) => GUARDED_KEYS.has(row.key))) return rows;
    const context = await this.contextFor(principal.companyId);
    return rows.map((row) =>
      GUARDED_KEYS.has(row.key) ? { ...row, value: this.redactValue(context, row.key, row.value) } : row,
    );
  }

  private redactValue(context: StolenContext, key: string, value: string): string {
    const parsed = parse(value);
    if (parsed === undefined) return value;
    if (key === UNIT_EXITS_KEY) return JSON.stringify(redactExits(parsed));
    if (key === COMPLIANCE_AUDIT_KEY) return JSON.stringify(redactWorkspaceAudit(context, parsed));
    if (key === TRUCK_NOTES_KEY) return JSON.stringify(redactTruckNotes(context, parsed));
    // The legacy single blob carries both collections inside it.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return value;
    const blob = { ...(parsed as Record<string, unknown>) };
    if ('unitExits' in blob) blob.unitExits = redactExits(blob.unitExits);
    if ('complianceAudit' in blob) blob.complianceAudit = redactWorkspaceAudit(context, blob.complianceAudit);
    if ('truckNotes' in blob) blob.truckNotes = redactTruckNotes(context, blob.truckNotes);
    return JSON.stringify(blob);
  }

  // ----------------------------------------------------------------------------- /state writes

  /**
   * What a non-admin's PUT actually stores: their array, with every entry hidden from them kept
   * exactly as stored (see `mergeProtected`). An admin's write, and every other key, pass through.
   */
  async mergeWrite(principal: Principal, key: string, value: string): Promise<string> {
    if (seesStolenDetails(principal) || !GUARDED_KEYS.has(key)) return value;
    const incoming = parse(value);
    if (incoming === undefined) return value;
    const storedRow = await this.state.getFor(principal.companyId, key);
    const stored = storedRow ? parse(storedRow.value) : undefined;
    if (stored === undefined) return value;
    const context = await this.contextFor(principal.companyId);

    if (key === UNIT_EXITS_KEY) {
      return JSON.stringify(mergeProtected(stored, incoming, isStolenRecord, exitKey));
    }
    if (key === COMPLIANCE_AUDIT_KEY) {
      return JSON.stringify(
        mergeProtected(stored, incoming, (row) => hidesWorkspaceAudit(context, row), workspaceAuditKey),
      );
    }
    if (key === TRUCK_NOTES_KEY) {
      return JSON.stringify(
        mergeProtected(stored, incoming, (row) => hidesTruckNote(context, row), truckNoteKey),
      );
    }
    const storedBlob = asObject(stored);
    const incomingBlob = asObject(incoming);
    if (!storedBlob || !incomingBlob) return value;
    const merged = { ...incomingBlob };
    if ('unitExits' in storedBlob || 'unitExits' in merged) {
      merged.unitExits = mergeProtected(storedBlob.unitExits, merged.unitExits ?? [], isStolenRecord, exitKey);
    }
    if ('complianceAudit' in storedBlob || 'complianceAudit' in merged) {
      merged.complianceAudit = mergeProtected(
        storedBlob.complianceAudit,
        merged.complianceAudit ?? [],
        (row) => hidesWorkspaceAudit(context, row),
        workspaceAuditKey,
      );
    }
    if ('truckNotes' in storedBlob || 'truckNotes' in merged) {
      merged.truckNotes = mergeProtected(
        storedBlob.truckNotes,
        merged.truckNotes ?? [],
        (row) => hidesTruckNote(context, row),
        truckNoteKey,
      );
    }
    return JSON.stringify(merged);
  }

  // ------------------------------------------------------------------------------- the source

  /**
   * The stored exit records: the split row, or - on a workspace that was never split - the legacy
   * blob's copy, the same fallback `StateService.workspace()` uses.
   */
  private async storedExits(companyId: string): Promise<unknown> {
    const row = await this.state.getFor(companyId, UNIT_EXITS_KEY);
    if (row) return parse(row.value) ?? [];
    const split = await this.state.listFor(companyId, WORKSPACE_PREFIX);
    if (split.length > 0) return [];
    const legacy = await this.state.getFor(companyId, LEGACY_WORKSPACE_KEY);
    if (!legacy) return [];
    return asObject(parse(legacy.value))?.unitExits ?? [];
  }
}

function parse(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
