import { describe, expect, it } from 'vitest';
import {
  RESTRICTED_SUMMARY,
  exitKey,
  hidesWorkspaceAudit,
  isStolenRecord,
  mergeProtected,
  redactAuditLogs,
  redactExits,
  seesStolenDetails,
  stolenContextFrom,
  workspaceAuditKey,
} from './stolen-privacy';
import type { Principal } from '../../common/auth/principal';

const principal = (roles: string[]): Principal => ({
  userId: 'u',
  companyId: 'c',
  companyTimezone: 'America/New_York',
  weekStart: 1,
  roles,
  permissions: new Set(['workspace.view']),
});

const stolen = {
  id: 'exit_1',
  entity: 'truck',
  unitId: 'trk_1',
  unitNumber: '101',
  toStatus: 'inactive',
  fromStatus: 'available',
  occurredOn: '2026-10-01',
  reason: 'stolen',
  narrative: 'Taken from the Gary yard overnight',
  policeReport: 'PR-123',
  stolenFrom: 'Gary, IN',
  contents: [{ label: 'Load', value: 5000, recovered: false }],
  damage: [],
  insuranceClaimNumber: 'CLM-9',
  recordedByName: 'Sarah Chen',
  createdAt: '2026-10-01T15:00:00.000Z',
};
const sold = { ...stolen, id: 'exit_2', unitId: 'trk_2', reason: 'sold', narrative: 'Sold to a dealer' };

describe('stolen-unit privacy rules', () => {
  it('only the administrator role sees the details', () => {
    expect(seesStolenDetails(principal(['administrator']))).toBe(true);
    expect(seesStolenDetails(principal(['operations_manager', 'fleet_manager']))).toBe(false);
  });

  it('a unit is stolen while its latest exit says so', () => {
    const recovered = { ...stolen, id: 'exit_3', reason: 'sold', createdAt: '2026-10-05T00:00:00.000Z' };
    expect([...stolenContextFrom([stolen, sold]).current]).toEqual(['trk_1']);
    expect(stolenContextFrom([stolen, recovered]).current.size).toBe(0);
    // Its audit lines from the theft on stay hidden either way.
    expect(stolenContextFrom([stolen, recovered]).since.has('trk_1')).toBe(true);
  });

  it('redacts stolen records to the same shape with nothing in it', () => {
    const [out, other] = redactExits([stolen, sold]) as Record<string, unknown>[];
    expect(out).toMatchObject({ id: 'exit_1', unitId: 'trk_1', reason: 'stolen', redacted: true, contents: [], damage: [] });
    expect(JSON.stringify(out)).not.toMatch(/Gary|PR-123|CLM-9|Sarah|2026-10-01/);
    expect(other).toBe(sold);
  });

  it('hides audit lines about the unit from the theft on, and lines that mention it', () => {
    const context = stolenContextFrom([stolen]);
    const before = { id: 'a', at: '2026-09-01T00:00:00Z', entity: { id: 'trk_1' }, reason: 'odometer fix' };
    const after = { id: 'b', at: '2026-10-01T15:00:00Z', entity: { id: 'trk_1' }, reason: 'stolen: Taken from the yard' };
    const elsewhere = { id: 'c', at: '2026-10-02T00:00:00Z', entity: { id: 'trk_9' }, reason: 'theft reported' };
    expect(hidesWorkspaceAudit(context, before)).toBe(false);
    expect(hidesWorkspaceAudit(context, after)).toBe(true);
    expect(hidesWorkspaceAudit(context, elsewhere)).toBe(true);

    const [line] = redactAuditLogs(context, [
      { entityId: 'trk_1', at: new Date('2026-10-02T00:00:00Z'), summary: 'Location Gary', reason: 'x', changes: [{ field: 'f', old: 'a', new: 'b' }] },
    ]);
    expect(line).toMatchObject({ summary: RESTRICTED_SUMMARY, reason: null, changes: [] });
  });

  it('a non-admin write keeps every protected stored entry and drops orphan placeholders', () => {
    const redacted = redactExits([stolen]) as unknown[];
    const fresh = { ...sold, id: 'exit_new', unitId: 'trk_3', reason: 'stolen', narrative: 'New theft' };
    const orphan = { id: 'exit_ghost', reason: 'stolen', redacted: true };
    const merged = mergeProtected([stolen, sold], [fresh, ...redacted, sold, orphan], isStolenRecord, exitKey) as unknown[];
    expect(merged).toEqual([fresh, stolen, sold]);
    // A dropped one comes back.
    expect(mergeProtected([stolen, sold], [sold], isStolenRecord, exitKey)).toEqual([sold, stolen]);
  });

  it('keys workspace audit lines on id and moment, since ids repeat', () => {
    expect(workspaceAuditKey({ id: 'aud_0001', at: 'x' })).not.toBe(workspaceAuditKey({ id: 'aud_0001', at: 'y' }));
  });
});
