/**
 * The permission registry.
 *
 * `docs/RBAC.md` §2 specifies that this lives in the shared package and is seeded into the
 * `permissions` table on migration. It is the single list of what this system can authorise, and
 * the rule that matters is at the bottom of this comment:
 *
 *   **Only permissions the backend actually enforces appear here.**
 *
 * A permission that exists in the registry but is checked nowhere is worse than no permission at
 * all: it tells an administrator they have restricted something when they have not. Every code
 * below is either checked by a `@RequirePermission` decorator, a guard, or an explicit service
 * check, and the test `permissions.test.ts` asserts the registry and the enforced set agree.
 */

export const PERMISSION_ACTIONS = [
  'view',
  'create',
  'edit',
  'archive',
  'approve',
  'assign',
  'export',
  'manage',
  'view_financial',
  // Insights scopes its reports by subject rather than by field sensitivity: a report is entirely
  // about money, the workforce or safety, so the whole report is gated rather than its columns.
  'view_people',
  'view_safety',
  // The dashboard's own drill-down permission, which predates this registry.
  'drilldown',
  // Payee bank details and payment batches (Accounting §10): the money-moving permission.
  'bank',
  // Driver Relations: recording that a driver was actually reached (owner, 2026-10-06).
  'contact',
  // Driver Relations: complaints and confidential call requests (owner, 2026-10-06).
  'confidential',
  // The Accounting overview page, kept from ordinary accounting staff (owner, 2026-10-13).
  'overview',
  // Claims v2 (2026-10-14): applying a driver deductible, and Management's exceptions.
  'apply_charges',
  'approve_exceptions',
  // Accident & Claims v2 (P1, owner 2026-10-21): scoped edits, restricted data, stage override, Dispatch confirmation.
  'edit_cargo',
  'restricted',
  'override',
  'confirm',
  // Accident & Claims v2 (P2): claim money edits and payments.
  'claim_money',
  // Accident & Claims v2 (P3): Fleet's work-order approval/completion and downtime verification; unit updates; AP bills from a case.
  'fleet',
  'edit_units',
  'bills',
  // Accident & Claims v2 (P4): recorded human decisions, legal liability, disciplinary reviews.
  'determine',
  'legal',
  'discipline',
  // Driver PII on the roster (owner brief, 2026-10-25, finding 5): contact, licence and pay fields.
  'view_contact',
  'view_licence',
  'view_pay',
] as const;
export type PermissionAction = (typeof PERMISSION_ACTIONS)[number];

export const PERMISSION_MODULES = [
  'administration',
  'operations',
  'fleet',
  'safety',
  'accounting',
  'people',
  'driver_relations',
  'insights',
] as const;
export type PermissionModule = (typeof PERMISSION_MODULES)[number];

export interface PermissionDefinition {
  code: string;
  module: PermissionModule;
  /** The area within the module, as it reads in the matrix. */
  group: string;
  action: PermissionAction;
  description: string;
  /**
   * True when granting this alone is meaningless without `view` on the same group. The matrix
   * grants the view automatically rather than letting somebody create a silently unusable role.
   */
  impliesView?: boolean;
}

/** The one code the driver app's routes require (`/driver/*`). */
export const DRIVER_APP_PERMISSION = 'driver_app.use';
/** The system role a driver login holds. */
export const DRIVER_ROLE_CODE = 'driver';
/**
 * Everything a driver membership may ever hold. The principal is cut down to this set whatever
 * roles the membership carries, so a driver login can never pick up an office permission.
 */
export const DRIVER_MEMBERSHIP_PERMISSIONS: readonly string[] = [DRIVER_APP_PERMISSION];

function group(
  module: PermissionModule,
  groupName: string,
  prefix: string,
  actions: { action: PermissionAction; description: string }[],
): PermissionDefinition[] {
  return actions.map(({ action, description }) => ({
    code: `${prefix}.${action}`,
    module,
    group: groupName,
    action,
    description,
    impliesView: action !== 'view',
  }));
}

/**
 * Every permission this system enforces.
 *
 * Grouped the way the matrix displays them. Adding a code here without a matching backend check is
 * a lie to whoever configures the role, so the paired test refuses it.
 */
export const PERMISSIONS: PermissionDefinition[] = [
  // ---------------------------------------------------------------------------- administration
  ...group('administration', 'Users', 'users', [
    { action: 'view', description: 'See accounts and their access' },
    { action: 'create', description: 'Create accounts and send invitations' },
    { action: 'edit', description: 'Change account details and status' },
    { action: 'assign', description: 'Assign roles to accounts' },
  ]),
  ...group('administration', 'Roles & permissions', 'roles', [
    { action: 'view', description: 'See roles and what they grant' },
    { action: 'create', description: 'Create roles' },
    { action: 'edit', description: 'Change what a role grants' },
    { action: 'archive', description: 'Retire a role no account uses' },
  ]),
  ...group('administration', 'Departments', 'departments', [
    { action: 'view', description: 'See the department structure' },
    { action: 'create', description: 'Create departments' },
    { action: 'edit', description: 'Rename departments and change their manager' },
    { action: 'archive', description: 'Deactivate a department' },
  ]),
  ...group('administration', 'Integrations', 'integrations', [
    { action: 'view', description: 'See connected external systems' },
    { action: 'manage', description: 'Connect, disconnect and replace credentials' },
  ]),
  ...group('administration', 'Workflows', 'workflows', [
    { action: 'view', description: 'See automation rules and their runs' },
    { action: 'create', description: 'Create automation rules' },
    { action: 'edit', description: 'Change or pause automation rules' },
  ]),
  ...group('administration', 'Audit log', 'audit', [
    { action: 'view', description: 'Read the audit trail' },
    { action: 'export', description: 'Export audit records' },
  ]),
  /*
   * Stored files (owner brief, 2026-10-25, finding 4): removing an unattached file (kept on disk,
   * restorable) and restoring it. Administrators only; files that belong to a record are never removed.
   */
  ...group('administration', 'Files', 'files', [
    { action: 'manage', description: 'Remove unattached files (kept, restorable), restore them and see removed files' },
  ]),
  ...group('administration', 'Settings', 'settings', [
    { action: 'view', description: 'See company configuration' },
    { action: 'edit', description: 'Change company configuration' },
  ]),
  // The driver application's legal documents, per company (owner brief, 2026-10-27).
  ...group('administration', 'Document templates', 'application_templates', [
    { action: 'manage', description: 'Upload, version and approve the company’s driver-application legal documents' },
  ]),

  // --------------------------------------------------------------------------------- operations
  ...group('operations', 'Loads', 'loads', [
    { action: 'view', description: 'See loads' },
    { action: 'create', description: 'Create loads' },
    { action: 'edit', description: 'Change load details' },
    { action: 'assign', description: 'Assign drivers and equipment' },
  ]),
  ...group('operations', 'Dispatch', 'dispatch', [
    { action: 'view', description: 'See the dispatch board' },
    { action: 'edit', description: 'Act on the dispatch board' },
    {
      action: 'manage',
      description:
        'Dispatch lead: cancel a load after it is dispatched, correct events older than two hours, override a blocked pick',
    },
  ]),
  /*
   * What dispatchers are paid, which is not the same question as running the board.
   *
   * The Weekly Report, the Commission policy and the Salary Report are one person's earnings
   * beside another's. A dispatch lead runs the shift and still has no business reading them, so
   * this is its own code rather than another use of `dispatch.manage` — and the boards, the
   * weekly sheet and Detention & Layover stay open to everyone who dispatches.
   */
  ...group('operations', 'Dispatcher pay', 'dispatch_pay', [
    { action: 'view', description: 'See the weekly report, the commission policy and the salary report' },
    { action: 'edit', description: 'Change the commission policy and run a salary period' },
  ]),
  /*
   * One board at a time (owner, 2026-09-30): Accounting reads the Weekly Board without running
   * dispatch. `dispatch.view` still opens every board, so no existing role loses one; these grant
   * a single board to somebody who has no business on the rest. Viewing only - writing a cell
   * stays `dispatch.edit`.
   */
  ...group('operations', 'Dispatch boards', 'board_daily', [
    { action: 'view', description: 'Open the Daily Board (read only without dispatch.edit)' },
  ]),
  ...group('operations', 'Dispatch boards', 'board_weekly', [
    { action: 'view', description: 'Open the Weekly Board (read only without dispatch.edit)' },
  ]),
  ...group('operations', 'Dispatch boards', 'board_performance', [
    { action: 'view', description: 'Open dispatcher Performance' },
  ]),
  ...group('operations', 'Dispatch boards', 'board_claims', [
    { action: 'view', description: 'Open Detention & Layover' },
  ]),
  ...group('operations', 'Customers', 'customers', [
    { action: 'view', description: 'See customers' },
    { action: 'edit', description: 'Change customer records' },
    { action: 'archive', description: 'Archive a customer' },
  ]),
  ...group('operations', 'Brokers', 'brokers', [
    { action: 'view', description: 'See brokers' },
    { action: 'edit', description: 'Change broker records' },
    { action: 'archive', description: 'Archive a broker' },
  ]),
  // NeWay AI (owner, 2026-10-20): every manager may use the assistant; each tool still asks for the
  // permission its own page needs. Turning Dry run off is the administrator's.
  { code: 'ai_assistant.use', module: 'administration', group: 'NeWay AI', action: 'view', description: 'Use the NeWay AI assistant', impliesView: false },
  { code: 'ai_assistant.manage', module: 'administration', group: 'NeWay AI', action: 'manage', description: 'Turn Dry run off so confirmed actions run, and see AI usage', impliesView: false },
  // Company info (owner, 2026-10-19): the carrier's own profile, the papers brokers ask for, the yards.
  ...group('operations', 'Company info', 'company_profile', [
    { action: 'view', description: 'See the company profile, its documents, and download the broker packet' },
    { action: 'edit', description: 'Change the company profile and upload or replace its documents' },
  ]),

  // -------------------------------------------------------------------------------------- fleet
  ...group('fleet', 'Trucks', 'trucks', [
    { action: 'view', description: 'See trucks' },
    { action: 'create', description: 'Add trucks' },
    { action: 'edit', description: 'Change truck records and status' },
  ]),
  // Assigning the driver on a truck without the rest of the truck record (owner, 2026-10-17):
  // fleet staff and dispatch leads hand units over; changing the unit itself stays trucks.edit.
  { code: 'truck_assignment.edit', module: 'fleet', group: 'Driver assignment', action: 'edit', description: 'Assign, change and end the driver on a truck', impliesView: false },
  // Clearing a fixed PTI defect without the rest of Safety (owner, 2026-11-02: maintenance could not press Verify & clear).
  { code: 'pti.verify', module: 'fleet', group: 'PTI defects', action: 'edit', description: 'Verify a fixed PTI defect and clear its hold', impliesView: false },
  /*
   * The driver app (owner brief 2026-10-27, docs/mobile/PLAN.md): a driver's own loads, paperwork
   * uploads, stop events and PTI, resolved on the server from the membership's linked driver. It
   * opens nothing office-wide; the system role `driver` holds this code and nothing else.
   */
  { code: 'driver_app.use', module: 'fleet', group: 'Driver app', action: 'view', description: 'Use the NeWay driver app as the linked driver: own loads, paperwork, stop events and PTI only', impliesView: false },
  ...group('fleet', 'Trailers', 'trailers', [
    { action: 'view', description: 'See trailers' },
    { action: 'edit', description: 'Change trailer records' },
  ]),
  ...group('fleet', 'Drivers', 'drivers', [
    { action: 'view', description: 'See driver profiles' },
    { action: 'create', description: 'Add drivers' },
    { action: 'edit', description: 'Change driver records and status' },
    // Without these the server masks the fields (roster/driver-pii.ts): phone and email reduced to
    // their last characters, licence and medical dates removed, pay hidden.
    { action: 'view_contact', description: 'See driver phone numbers, email and home city' },
    { action: 'view_licence', description: 'See driver CDL details and medical card dates' },
    { action: 'view_pay', description: 'See driver pay plans and rates' },
  ]),
  /*
   * Maintenance is two permissions, not one, because it has two readers.
   *
   * A mechanic needs to open a work order, move it through the shop and write down what was done.
   * They have no business seeing what the shop charged, and until this split `maintenance.view`
   * granted both — it was the permission gating the expense summary, so a role that let somebody
   * work the shop floor also handed them every invoice total in the company.
   */
  ...group('fleet', 'Maintenance', 'maintenance', [
    { action: 'view', description: 'See work orders, service schedules and the Today board' },
    { action: 'edit', description: 'Open work orders, move them through the shop and complete them' },
  ]),
  ...group('fleet', 'Maintenance costs', 'maintenance_costs', [
    {
      action: 'view',
      description: 'See what maintenance cost: invoice totals, vendor prices and spend reports',
    },
  ]),

  /*
   * The workspace snapshot.
   *
   * `GET /state` answers with the operational dataset as one object — loads, brokers, dispatch,
   * inspections. It carried no permission at all, so any signed-in account could read all of it,
   * which is why the Maintenance role has to be kept out of it explicitly rather than by omission.
   */
  ...group('operations', 'Workspace', 'workspace', [
    { action: 'view', description: 'Read the operational workspace (loads, brokers, dispatch)' },
    { action: 'edit', description: 'Write to the operational workspace' },
  ]),

  // ------------------------------------------------------------------------------------- safety
  ...group('safety', 'Safety', 'safety', [
    { action: 'view', description: 'See inspections, violations and accidents' },
    { action: 'manage', description: 'Record and resolve safety records' },
  ]),
  ...group('safety', 'Compliance', 'compliance', [
    { action: 'view', description: 'See qualification files' },
    { action: 'manage', description: 'Verify and waive requirements' },
  ]),
  /*
   * Restricted records (owner, 2026-10-02). Drug and alcohol results, and the details of the
   * sensitive qualification records (MVR, PSP, Clearinghouse, medical), are redacted by the server
   * for anybody without these codes - not merely hidden by the screen. Administrators and Safety
   * Managers hold them; nobody else does unless a company grants them on purpose.
   */
  ...group('safety', 'Drug & alcohol testing', 'safety_testing', [
    { action: 'view', description: 'See drug and alcohol test results (restricted)' },
    { action: 'manage', description: 'Record test results and review testing exceptions' },
  ]),
  ...group('safety', 'Sensitive qualification records', 'compliance_sensitive', [
    { action: 'view', description: 'See MVR, PSP, Clearinghouse and medical details and files' },
  ]),
  // W-9s for 1099s (owner, 2026-10-25): Accounting reads the W-9 record and file, nothing else of the driver file.
  ...group('safety', 'Sensitive qualification records', 'driver_tax_forms', [
    { action: 'view', description: 'See driver W-9 records and files (for 1099s), and no other personnel record' },
  ]),
  ...group('safety', 'Claims', 'claims', [
    { action: 'apply_charges', description: 'Apply a driver deductible or chargeback on a claim (Safety)' },
    { action: 'approve_exceptions', description: 'Management: waivers, amounts over policy or cuts over the threshold, dispute decisions' },
  ]),
  /*
   * Accident & Claims v2 (docs/accidents, behind accidents_v2). Its own group, so granting the board to
   * Fleet, Dispatch and Accounting (SPEC §8.3: everybody views non-restricted cases) does not open the
   * rest of Safety. Restricted = medical details, test results and restricted timeline entries, redacted by
   * the server; the owner's mapping (2026-10-21) gives it to Safety Managers and Administrators only.
   */
  ...group('safety', 'Accidents (v2)', 'accidents', [
    { action: 'view', description: 'See accident cases, tasks and timelines (restricted details stay hidden)' },
    { action: 'edit', description: 'Report accidents and edit case facts, tasks and evidence' },
    { action: 'edit_cargo', description: 'Dispatch: update cargo and load fields on an accident' },
    { action: 'restricted', description: 'See and edit restricted accident details: medical, test results, restricted entries' },
    { action: 'override', description: 'Override stage conditions, close administratively, legal hold' },
    { action: 'confirm', description: 'Dispatch: confirm an accident request (unit unavailable, repower, broker notice)' },
    { action: 'claim_money', description: 'Claims: edit claimed / reserve / deductible / settlement amounts and record claim payments' },
    { action: 'fleet', description: 'Fleet: open accident repair work orders, add / approve estimates, start and complete repairs, verify downtime' },
    { action: 'edit_units', description: 'Fleet: update a unit on an accident (where it is, damage, tow, storage)' },
    { action: 'bills', description: 'Accounting: add towing / storage / rental invoices to Accounts Payable from an accident' },
    { action: 'determine', description: 'Record driver fault, preventability and the FMCSA crash preventability (CPDP) status' },
    { action: 'approve', description: 'Approve or send back an accident investigation' },
    { action: 'legal', description: 'See and record legal liability (restricted)' },
    { action: 'discipline', description: 'Create, see and decide disciplinary reviews (restricted personnel action)' },
  ]),
  ...group('safety', 'Documents', 'documents', [
    { action: 'create', description: 'Attach documents to a record' },
  ]),

  // --------------------------------------------------------------------------------- accounting
  ...group('accounting', 'Accounting', 'accounting', [
    { action: 'view', description: 'See the ledger, invoices, receivables, payables and expenses' },
    { action: 'edit', description: 'Post and edit accounting records' },
    { action: 'bank', description: 'See, change and verify payee bank details; approve and export payment batches' },
    { action: 'overview', description: 'Open the Accounting overview page (company totals, ledger and settings) - for the accounting manager' },
  ]),
  ...group('accounting', 'Payroll', 'payroll', [
    { action: 'view', description: 'See payroll periods and payslips' },
  ]),

  // ------------------------------------------------------------------------------------- people
  ...group('people', 'Employees', 'employees', [
    { action: 'view', description: 'See the workforce' },
    { action: 'create', description: 'Add employees' },
    { action: 'edit', description: 'Change employee records' },
    { action: 'view_financial', description: 'See compensation' },
    { action: 'manage', description: 'Change employment status and assignments' },
  ]),
  ...group('people', 'Recruiting', 'recruiting', [
    { action: 'view', description: 'See candidates and openings' },
    { action: 'manage', description: 'Move candidates, make offers and hire' },
  ]),
  ...group('people', 'Onboarding', 'onboarding', [
    { action: 'view', description: 'See onboarding plans' },
    { action: 'manage', description: 'Create plans and complete items' },
  ]),
  ...group('people', 'Attendance', 'attendance', [
    { action: 'view', description: 'See attendance' },
    { action: 'manage', description: 'Record and correct attendance' },
    { action: 'approve', description: 'Approve attendance' },
  ]),
  ...group('people', 'PTO', 'pto', [
    { action: 'view', description: 'See time off' },
    { action: 'create', description: 'Submit requests' },
    { action: 'approve', description: 'Decide requests' },
    { action: 'manage', description: 'Configure policies and adjust balances' },
  ]),
  ...group('people', 'Performance', 'performance', [
    { action: 'view', description: 'See goals and reviews' },
    { action: 'manage', description: 'Set goals, write reviews and see private feedback' },
  ]),

  // --------------------------------------------------------------------------- driver relations
  /*
   * Driver Relations (owner, 2026-10-06): every request from the Driver Care page. Viewing is the
   * read-only path; contact is the agent's work (assign, record attempts and contact, notes,
   * resolve, reopen, link verified records); manage adds the public Driver Care links.
   */
  ...group('driver_relations', 'Driver Relations', 'driver_relations', [
    { action: 'view', description: 'See driver requests, their activity and the alert counts' },
    { action: 'contact', description: 'Assign requests, record attempts and contact, add notes, resolve and reopen' },
    {
      action: 'confidential',
      description: 'See Complaint & Feedback and confidential call requests (hidden from everyone else, in every list, count and file)',
    },
    { action: 'manage', description: 'Create and switch off the public Driver Care links' },
  ]),

  // ----------------------------------------------------------------------------------- insights
  ...group('insights', 'Reports', 'reports', [
    { action: 'view', description: 'Run operational reports' },
    { action: 'view_financial', description: 'Run financial reports' },
    { action: 'view_people', description: 'Run workforce reports' },
    { action: 'view_safety', description: 'Run safety reports' },
  ]),
  ...group('insights', 'Analytics', 'analytics', [
    { action: 'view', description: 'See analytics' },
  ]),
  ...group('insights', 'Dashboard', 'dashboard', [
    { action: 'view', description: 'See the dashboard' },
    { action: 'view_financial', description: 'See money on the dashboard' },
    { action: 'drilldown', description: 'Open dashboard drill-downs' },
  ]),
];

export const PERMISSION_CODES = PERMISSIONS.map((p) => p.code);

/** Permissions grouped for the matrix: module → group → the actions it offers. */
export interface PermissionGroup {
  module: PermissionModule;
  group: string;
  permissions: PermissionDefinition[];
}

export function permissionMatrix(): PermissionGroup[] {
  const groups = new Map<string, PermissionGroup>();
  for (const permission of PERMISSIONS) {
    const key = `${permission.module}:${permission.group}`;
    const existing = groups.get(key);
    if (existing) existing.permissions.push(permission);
    else {
      groups.set(key, {
        module: permission.module,
        group: permission.group,
        permissions: [permission],
      });
    }
  }
  return [...groups.values()];
}

/**
 * Expands a selection so it cannot be internally contradictory.
 *
 * Granting `loads.edit` without `loads.view` produces a role that can change something it cannot
 * open. The matrix adds the view rather than letting an administrator save a role that silently
 * does not work.
 */
export function withImpliedPermissions(codes: readonly string[]): string[] {
  const selected = new Set(codes);
  for (const code of codes) {
    const definition = PERMISSIONS.find((p) => p.code === code);
    if (!definition?.impliesView) continue;
    const prefix = code.slice(0, code.lastIndexOf('.'));
    const view = `${prefix}.view`;
    if (PERMISSION_CODES.includes(view)) selected.add(view);
  }
  return [...selected].sort();
}

/**
 * The roles this product ships with.
 *
 * System roles cannot be edited or archived — an administrator who removes `users.edit` from
 * "Administrator" locks the company out of its own account management. They can be copied into a
 * custom role and changed there.
 */
export interface SystemRoleDefinition {
  code: string;
  name: string;
  description: string;
  permissions: readonly string[];
}

const ALL = PERMISSION_CODES;

export const SYSTEM_ROLES: SystemRoleDefinition[] = [
  {
    code: 'administrator',
    name: 'Administrator',
    description: 'Full access, including administration and company configuration.',
    permissions: ALL,
  },
  {
    code: 'operations_manager',
    name: 'Operations Manager',
    description: 'Runs dispatch and the fleet; sees the workforce but not pay.',
    permissions: [
      'ai_assistant.use',
      'loads.view', 'loads.create', 'loads.edit', 'loads.assign',
      'dispatch.view', 'dispatch.edit', 'dispatch.manage',
      'customers.view', 'customers.edit', 'brokers.view', 'brokers.edit', 'company_profile.view', 'company_profile.edit',
      'trucks.view', 'trucks.edit', 'truck_assignment.edit', 'trailers.view', 'trailers.edit',
      'drivers.view', 'drivers.edit', 'drivers.view_contact', 'drivers.view_licence', 'maintenance.view', 'maintenance_costs.view',
      'safety.view', 'employees.view',
      'accidents.view', 'accidents.edit', 'accidents.fleet', 'accidents.determine',
      'attendance.view', 'attendance.approve', 'pto.view', 'pto.approve',
      'performance.view', 'onboarding.view',
      'reports.view', 'analytics.view',
      'workspace.view', 'workspace.edit',
    ],
  },
  {
    code: 'dispatcher',
    name: 'Dispatcher',
    description: 'Books and assigns freight.',
    permissions: [
      'loads.view', 'loads.create', 'loads.edit', 'loads.assign',
      'dispatch.view', 'dispatch.edit',
      'drivers.view', 'drivers.view_contact', 'trucks.view', 'trailers.view',
      'customers.view', 'brokers.view', 'company_profile.view',
      'reports.view',
      'workspace.view', 'workspace.edit',
      'accidents.view', 'accidents.edit_cargo',
    ],
  },
  {
    /*
     * A dispatcher who is also the shift's lead.
     *
     * The same seat as Dispatcher plus `dispatch.manage`: the one code the load rules ask for
     * when a cancel comes after the driver was dispatched, when an event older than two hours is
     * corrected, or when a blocked pick is overridden (docs/dispatch/00-plan.md). The server
     * checks it; the screen only shows or hides the button.
     */
    code: 'dispatch_lead',
    name: 'Dispatch Lead',
    description: 'A dispatcher who can cancel after dispatch, correct old events and override a blocked pick.',
    permissions: [
      'ai_assistant.use',
      'loads.view', 'loads.create', 'loads.edit', 'loads.assign',
      'dispatch.view', 'dispatch.edit', 'dispatch.manage',
      'drivers.view', 'drivers.view_contact', 'trucks.view', 'trailers.view', 'truck_assignment.edit',
      'customers.view', 'brokers.view', 'company_profile.view',
      'reports.view',
      'workspace.view', 'workspace.edit',
      'accidents.view', 'accidents.edit_cargo', 'accidents.confirm',
    ],
  },
  {
    code: 'safety_manager',
    name: 'Safety Manager',
    description: 'Owns compliance, inspections, violations and accidents.',
    permissions: [
      'ai_assistant.use',
      'safety.view', 'safety.manage', 'compliance.view', 'compliance.manage', 'company_profile.view', 'company_profile.edit',
      'safety_testing.view', 'safety_testing.manage', 'compliance_sensitive.view',
      'claims.apply_charges',
      'documents.create', 'drivers.view', 'drivers.edit', 'drivers.view_contact', 'drivers.view_licence', 'trucks.view',
      'employees.view', 'reports.view', 'reports.view_safety', 'analytics.view',
      'workspace.view', 'workspace.edit',
      'accidents.view', 'accidents.edit', 'accidents.restricted', 'accidents.override', 'accidents.claim_money', 'accidents.fleet',
      'accidents.determine', 'accidents.approve', 'accidents.legal', 'accidents.discipline',
    ],
  },
  {
    code: 'fleet_manager',
    name: 'Fleet Manager',
    description: 'Owns equipment, maintenance and fuel.',
    permissions: [
      'ai_assistant.use',
      'trucks.view', 'trucks.create', 'trucks.edit', 'truck_assignment.edit',
      'trailers.view', 'trailers.edit', 'maintenance.view', 'maintenance.edit',
      'maintenance_costs.view',
      'drivers.view', 'drivers.view_contact', 'reports.view', 'analytics.view',
      'workspace.view', 'workspace.edit',
      'accidents.view', 'accidents.fleet', 'accidents.edit_units',
      'pti.verify',
    ],
  },
  {
    /*
     * The shop floor.
     *
     * Deliberately the narrowest role in the system: a mechanic opens the Today board, works the
     * queue and writes down what was done. No costs, no vendor prices, no spend reports — the
     * absence of `maintenance_costs.view` is what this role is for.
     */
    code: 'maintenance',
    name: 'Maintenance',
    description: 'Works the shop queue. Sees what is due and what is in; never what it cost.',
    permissions: [
      'maintenance.view',
      'maintenance.edit',
      'trucks.view',
      // Fleet staff register new units (owner, 2026-10-17: Dominic could not add 0060); editing stays trucks.edit.
      'trucks.create',
      'truck_assignment.edit',
      'trailers.view',
      'documents.create',
      'accidents.view', 'accidents.edit_units',
      'pti.verify',
    ],
  },
  {
    code: 'accounting',
    name: 'Accounting',
    description: 'Invoicing, settlements and payroll.',
    permissions: [
      'ai_assistant.use',
      'accounting.view', 'accounting.edit', 'accounting.bank',
      'payroll.view', 'customers.view', 'brokers.view', 'company_profile.view', 'company_profile.edit', 'loads.view',
      'drivers.view_pay',
      // W-9s for 1099s (owner, 2026-10-25): the W-9 alone, not the rest of the driver file.
      'driver_tax_forms.view',
      'employees.view', 'employees.view_financial',
      'reports.view', 'reports.view_financial', 'analytics.view',
      'workspace.view', 'workspace.edit',
      // The Weekly Board's gross is what Accounting reconciles against (owner, 2026-09-30).
      'board_weekly.view',
      // Weekly Report, Salary Report and Commission are for Accounting and Administrator only
      // (owner, 2026-10-26). Viewing only; changing the policy or running a period stays dispatch_pay.edit.
      'dispatch_pay.view',
      'accidents.view', 'accidents.claim_money', 'accidents.bills',
    ],
  },
  {
    code: 'hr_manager',
    name: 'HR Manager',
    description: 'Owns the workforce lifecycle end to end.',
    permissions: [
      'ai_assistant.use',
      'employees.view', 'employees.create', 'employees.edit',
      'employees.view_financial', 'employees.manage',
      'recruiting.view', 'recruiting.manage',
      'onboarding.view', 'onboarding.manage',
      'attendance.view', 'attendance.manage', 'attendance.approve',
      'pto.view', 'pto.create', 'pto.approve', 'pto.manage',
      'performance.view', 'performance.manage',
      'departments.view', 'drivers.view', 'drivers.view_contact', 'drivers.view_licence',
      'reports.view', 'reports.view_people', 'analytics.view',
    ],
  },
  {
    /*
     * The Driver Relations agent (owner, 2026-10-06): works the requests drivers send from the
     * Driver Care page. Reads the roster to verify who wrote; never sees money.
     */
    code: 'driver_relations',
    name: 'Driver Relations',
    description: 'Works driver requests from the Driver Care page: contacts drivers and follows up.',
    permissions: ['driver_relations.view', 'driver_relations.contact', 'driver_relations.confidential', 'drivers.view', 'drivers.view_contact', 'trucks.view'],
  },
  {
    code: 'read_only',
    name: 'Read only',
    description: 'Sees operational data, changes nothing.',
    permissions: [
      'loads.view', 'dispatch.view', 'drivers.view',
      'trucks.view', 'trailers.view', 'maintenance.view', 'safety.view',
      'employees.view', 'reports.view', 'analytics.view',
      'workspace.view',
      'accidents.view',
    ],
  },
  {
    /*
     * A driver signing in to the NeWay driver app (owner brief 2026-10-27). Given only through
     * Give app access on the driver's profile, which links the membership to the roster driver.
     * Everything the app reads is that driver's own, resolved on the server.
     */
    code: 'driver',
    name: 'Driver',
    description: 'Signs in to the driver app: own loads, paperwork, stop events and PTI. Nothing office-wide.',
    permissions: [DRIVER_APP_PERMISSION],
  },
];

/** The permission that guards administration itself. Used by the super-admin safety check. */
export const ADMIN_CRITICAL_PERMISSIONS = ['users.edit', 'roles.edit'] as const;
