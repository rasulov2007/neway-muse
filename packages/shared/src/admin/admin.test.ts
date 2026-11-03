import { describe, expect, it } from 'vitest';
import { REPORTS } from '../analytics/catalog.js';
import {
  ADMIN_CRITICAL_PERMISSIONS,
  ANY_CONNECTOR_IMPLEMENTED,
  CreateWorkflowSchema,
  INTEGRATION_PROVIDERS,
  INTEGRATION_STATUSES,
  INVITATION_DELIVERY,
  PERMISSIONS,
  PERMISSION_CODES,
  SETTINGS,
  SETTING_SCHEMAS,
  SYSTEM_ROLES,
  WORKFLOW_ACTIONS,
  WORKFLOW_TRIGGERS,
  buildDepartmentTree,
  conditionMatches,
  credentialHint,
  permissionMatrix,
  ruleMatches,
  withImpliedPermissions,
  type Department,
  type TriggerEvent,
} from './index.js';

describe('permission registry', () => {
  it('has no duplicate codes', () => {
    expect(new Set(PERMISSION_CODES).size).toBe(PERMISSION_CODES.length);
  });

  it('grants every role only codes the registry defines', () => {
    for (const role of SYSTEM_ROLES) {
      const unknown = role.permissions.filter((code) => !PERMISSION_CODES.includes(code));
      expect(unknown, `${role.code} grants unknown permissions`).toEqual([]);
    }
  });

  it('gives the administrator role every permission, so the company is never locked out', () => {
    const administrator = SYSTEM_ROLES.find((role) => role.code === 'administrator');
    expect(administrator?.permissions).toEqual(PERMISSION_CODES);
    for (const critical of ADMIN_CRITICAL_PERMISSIONS) {
      expect(administrator?.permissions).toContain(critical);
    }
  });

  it('is the only role with both critical permissions, which the lockout guard depends on', () => {
    const holders = SYSTEM_ROLES.filter((role) =>
      ADMIN_CRITICAL_PERMISSIONS.every((code) => role.permissions.includes(code)),
    );
    expect(holders.map((role) => role.code)).toEqual(['administrator']);
  });

  it('adds the matching view when an action is granted without one', () => {
    expect(withImpliedPermissions(['loads.edit'])).toEqual(['loads.edit', 'loads.view']);
    // A view granted on its own implies nothing further.
    expect(withImpliedPermissions(['loads.view'])).toEqual(['loads.view']);
  });

  it('contains every permission the report catalogue enforces', () => {
    // The registry is a promise that a permission somebody switches on is a permission the backend
    // checks. It was broken exactly once: the reports module enforced `reports.view_people` and
    // `reports.view_safety`, and neither existed here, so no role could grant them and the
    // workforce reports were unreachable for everybody but a hardcoded demo list.
    const enforced = [...new Set(REPORTS.map((report) => report.permission))];
    const missing = enforced.filter((code) => !PERMISSION_CODES.includes(code));
    expect(missing).toEqual([]);
  });

  it('groups the matrix without losing a permission', () => {
    const grouped = permissionMatrix().flatMap((group) => group.permissions);
    expect(grouped).toHaveLength(PERMISSIONS.length);
  });
});

describe('department tree', () => {
  const base = (id: string, parent: string | null): Department => ({
    id,
    code: id,
    name: id,
    description: null,
    parentDepartmentId: parent,
    parentName: null,
    managerEmployeeId: null,
    managerName: null,
    status: 'active',
    isSystem: false,
    employeeCount: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
  });

  it('nests children under their parent and stamps the depth', () => {
    const tree = buildDepartmentTree([base('ops', null), base('dispatch', 'ops')]);
    expect(tree).toHaveLength(1);
    expect(tree[0]?.children[0]?.id).toBe('dispatch');
    expect(tree[0]?.children[0]?.depth).toBe(1);
  });

  it('does not hang or lose a node when two departments point at each other', () => {
    const tree = buildDepartmentTree([base('a', 'b'), base('b', 'a')]);
    // Both survive at the root rather than disappearing into a cycle nobody can see.
    expect(tree.map((node) => node.id).sort()).toEqual(['a', 'b']);
  });

  it('keeps a department whose parent does not exist', () => {
    const tree = buildDepartmentTree([base('orphan', 'missing')]);
    expect(tree.map((node) => node.id)).toEqual(['orphan']);
  });
});

describe('workflow matching', () => {
  const event: TriggerEvent = {
    entityType: 'employee',
    action: 'status_change',
    entityLabel: 'Malik Allen',
    summary: 'Employment status: active → terminated',
    changes: [{ field: 'status', old: 'active', new: 'terminated' }],
  };

  it('matches a rule whose trigger and conditions both hold', () => {
    expect(
      ruleMatches(
        {
          trigger: 'employee:status_change',
          conditions: [{ operator: 'field_changed_to', field: 'status', value: 'terminated' }],
        },
        event,
      ),
    ).toBe(true);
  });

  it('does not match a different trigger', () => {
    expect(ruleMatches({ trigger: 'employee:create', conditions: [] }, event)).toBe(false);
  });

  it('requires every condition, not any', () => {
    expect(
      ruleMatches(
        {
          trigger: 'employee:status_change',
          conditions: [
            { operator: 'field_changed_to', field: 'status', value: 'terminated' },
            { operator: 'label_contains', field: '', value: 'someone else' },
          ],
        },
        event,
      ),
    ).toBe(false);
  });

  it('matches every event of the kind when there are no conditions', () => {
    expect(ruleMatches({ trigger: 'employee:status_change', conditions: [] }, event)).toBe(true);
  });

  it('reads the recorded change rather than the entity as it looks now', () => {
    expect(
      conditionMatches({ operator: 'field_changed_from', field: 'status', value: 'active' }, event),
    ).toBe(true);
    expect(
      conditionMatches({ operator: 'field_changed', field: 'department', value: '' }, event),
    ).toBe(false);
  });

  it('only offers triggers with a matching entity type and action', () => {
    for (const trigger of WORKFLOW_TRIGGERS) {
      expect(trigger.id).toMatch(/^[a-z_]+:[a-z_]+$/);
    }
    expect(new Set(WORKFLOW_TRIGGERS.map((t) => t.id)).size).toBe(WORKFLOW_TRIGGERS.length);
  });

  it('refuses a rule with no action at all', () => {
    const result = CreateWorkflowSchema.safeParse({
      name: 'Nothing happens',
      trigger: 'employee:create',
      actions: [],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a rule built on a trigger nothing emits', () => {
    const result = CreateWorkflowSchema.safeParse({
      name: 'Impossible',
      trigger: 'unicorn:appeared',
      actions: [{ type: 'notify', roleCode: 'hr_manager', title: 'x' }],
    });
    expect(result.success).toBe(false);
  });

  it('refuses a webhook that is not https', () => {
    const result = CreateWorkflowSchema.safeParse({
      name: 'Insecure',
      trigger: 'employee:create',
      actions: [{ type: 'webhook', url: 'http://example.com/hook' }],
    });
    expect(result.success).toBe(false);
  });

  it('marks the email action as not implemented, with a reason', () => {
    const email = WORKFLOW_ACTIONS.find((action) => action.type === 'email');
    expect(email?.implemented).toBe(false);
    expect(email?.reason).toMatch(/mail transport/i);
  });
});

describe('integrations', () => {
  it('has a "connected" status now that a connector can earn it', () => {
    expect(INTEGRATION_STATUSES).toContain('connected');
  });

  it('implements Samsara, Motive, Five ELD, Relay, Twilio, RTS and Azure Speech and says why every other provider is not', () => {
    expect(ANY_CONNECTOR_IMPLEMENTED).toBe(true);
    for (const provider of INTEGRATION_PROVIDERS) {
      if (provider.provider === 'relay' || provider.provider === 'twilio' || provider.provider === 'rts' || provider.provider === 'azure_speech') {
        expect(provider.connector.implemented, provider.provider).toBe(true);
      } else if (provider.provider === 'samsara' || provider.provider === 'motive' || provider.provider === 'fiveeld') {
        expect(provider.connector.implemented, provider.provider).toBe(true);
        // Read-only, and the list of what it reads says so: nothing here writes to an ELD.
        expect(provider.wouldSync.join(' '), provider.provider).not.toMatch(/write|post|push/i);
      } else {
        expect(provider.connector.implemented, provider.provider).toBe(false);
        expect(provider.connector.reason, provider.provider).toBeTruthy();
      }
    }
  });

  it('gives every provider at least one secret field to store', () => {
    for (const provider of INTEGRATION_PROVIDERS) {
      expect(
        provider.credentialFields.some((field) => field.kind === 'secret'),
        provider.provider,
      ).toBe(true);
    }
  });

  it('masks a credential down to four characters', () => {
    expect(credentialHint('samsara-secret-token-ABCD1234')).toBe('••••••••1234');
    expect(credentialHint('abc')).toBe('••••••••');
    expect(credentialHint('samsara-secret-token-ABCD1234')).not.toContain('secret');
  });
});

describe('settings', () => {
  it('validates every key it offers', () => {
    for (const setting of SETTINGS) {
      expect(SETTING_SCHEMAS[setting.key], setting.key).toBeDefined();
    }
  });

  it('gives a reason for every setting nothing reads yet', () => {
    for (const setting of SETTINGS.filter((s) => s.enforcedBy === null)) {
      expect(setting.notEnforcedReason, setting.key).toBeTruthy();
    }
  });

  it('rejects a timezone this carrier does not operate in', () => {
    expect(SETTING_SCHEMAS['company.timezone']?.safeParse('Europe/Berlin').success).toBe(false);
    expect(SETTING_SCHEMAS['company.timezone']?.safeParse('America/Chicago').success).toBe(true);
  });
});

describe('invitations', () => {
  it('says plainly that no email is sent', () => {
    expect(INVITATION_DELIVERY.available).toBe(false);
    expect(INVITATION_DELIVERY.reason).toMatch(/no invitation email is sent/i);
  });
});

describe('roles that work in the browser workspace', () => {
  // Maintenance is deliberately not here: the workspace carries invoice totals and that role must
  // never see money (work-orders.service.spec). Its Fleet pages read the server instead.
  it.each(['fleet_manager', 'safety_manager', 'dispatcher'])('%s can read and save it', (code) => {
    const role = SYSTEM_ROLES.find((r) => r.code === code);
    expect(role?.permissions).toContain('workspace.view');
    expect(role?.permissions).toContain('workspace.edit');
  });
});
