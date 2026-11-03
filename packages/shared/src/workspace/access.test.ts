import { describe, expect, it } from 'vitest';
import { SYSTEM_ROLES } from '../admin/permissions.js';
import { PERMISSION_CODES } from '../admin/permissions.js';
import {
  WORKSPACE_COLLECTION_POLICIES,
  WORKSPACE_EXTRA_KEY_POLICIES,
  canReadWorkspaceKey,
  canWriteWorkspaceKey,
  stripCostsFromValue,
  workspaceKeyPolicy,
} from './access.js';
import { WORKSPACE_COLLECTIONS, workspaceKey } from './keys.js';

const grants = (role: string) => SYSTEM_ROLES.find((r) => r.code === role)!.permissions;

describe('workspace key policies (owner, 2026-10-25)', () => {
  it('every collection has a policy, and every code in it is grantable', () => {
    for (const name of WORKSPACE_COLLECTIONS) {
      const policy = workspaceKeyPolicy(workspaceKey(name));
      expect(policy, name).not.toBeNull();
      for (const code of [...policy!.read, ...policy!.write]) expect(PERMISSION_CODES, `${name}: ${code}`).toContain(code);
    }
    for (const [key, policy] of Object.entries(WORKSPACE_EXTRA_KEY_POLICIES)) {
      for (const code of policy.read) expect(PERMISSION_CODES, `${key}: ${code}`).toContain(code);
    }
    expect(Object.keys(WORKSPACE_COLLECTION_POLICIES).sort()).toEqual([...WORKSPACE_COLLECTIONS].sort());
  });

  it('refuses a key nobody listed, for reading and writing', () => {
    expect(canReadWorkspaceKey(grants('administrator'), 'ws2-unknown')).toBe(false);
    expect(canWriteWorkspaceKey(grants('administrator'), 'srv-recruit-stage-marks')).toBe(false);
  });

  it('the administrator reads and writes every collection', () => {
    for (const name of WORKSPACE_COLLECTIONS) {
      expect(canReadWorkspaceKey(grants('administrator'), workspaceKey(name)), name).toBe(true);
      expect(canWriteWorkspaceKey(grants('administrator'), workspaceKey(name)), name).toBe(true);
    }
  });

  it('the maintenance seat works PTI and never reaches money', () => {
    const m = grants('maintenance');
    for (const name of ['ptiRecords', 'ptiRatings', 'ptiComponents', 'downPeriods', 'inspections', 'defects'] as const) {
      expect(canWriteWorkspaceKey(m, workspaceKey(name)), name).toBe(true);
    }
    for (const name of ['invoices', 'payments', 'settlements', 'journal', 'bills'] as const) {
      expect(canReadWorkspaceKey(m, workspaceKey(name)), name).toBe(false);
    }
    expect(canReadWorkspaceKey(m, workspaceKey('repairOrders'))).toBe(true);
    expect(canWriteWorkspaceKey(m, workspaceKey('repairOrders'))).toBe(false);
  });

  it('writing needs reading too', () => {
    expect(canWriteWorkspaceKey(['accounting.edit'], workspaceKey('invoices'))).toBe(false);
    expect(canWriteWorkspaceKey(['accounting.view', 'accounting.edit'], workspaceKey('invoices'))).toBe(true);
  });

  it('the legacy blob is the administrator\x27s alone', () => {
    expect(canReadWorkspaceKey(grants('dispatcher'), 'demo-data-v1')).toBe(false);
    expect(canReadWorkspaceKey(grants('administrator'), 'demo-data-v1')).toBe(true);
    expect(canReadWorkspaceKey(grants('read_only'), 'ws2-loads')).toBe(true);
  });

  it('nobody writes the pre-split loads row or the legacy blob through /state', () => {
    expect(canWriteWorkspaceKey(grants('administrator'), 'ws2-loads')).toBe(false);
    expect(canWriteWorkspaceKey(grants('administrator'), 'demo-data-v1')).toBe(false);
  });
});

describe('stripping (maintenance costs only; load prices are never stripped, owner 2026-10-25)', () => {
  it('nulls maintenance costs at any depth', () => {
    const out = JSON.parse(stripCostsFromValue(JSON.stringify([{ id: 'r', total: 9, lines: [{ price: 3, description: 'pads' }], vendor: 'A' }])));
    expect(out).toEqual([{ id: 'r', total: null, lines: [{ price: null, description: 'pads' }], vendor: 'A' }]);
  });

  it('withholds a value it cannot parse rather than serving it raw', () => {
    expect(stripCostsFromValue('not json')).toBe('null');
  });
});
