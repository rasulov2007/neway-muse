import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { companies } from './roster';
import { employees } from './people';

/**
 * Administration: the control plane.
 *
 * Shapes follow `docs/RBAC.md` §1–2 and `docs/DATABASE.md` §3.1–3.2, which were committed before
 * any of this existed. The one structural decision worth calling out is the split those documents
 * already make and this schema keeps:
 *
 *   `users`       a person who can sign in. **No `company_id`** — a user is a person, not a tenant
 *                 record, and the same person may one day belong to two carriers.
 *   `memberships` that person's access *to one company*, optionally tied to an employee record.
 *   `employees`   the workforce record. Already exists; untouched here.
 *
 * Access is therefore always company-scoped through a membership, never through the user row.
 */

// ========================================================================================= users

export const users = pgTable(
  'users',
  {
    id: text('id').primaryKey(),
    /** Globally unique: one login per email address across the platform. */
    email: text('email').notNull(),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    phone: text('phone'),
    /**
     * Nullable because an account created without a credential has no password until an
     * administrator issues one. Written by `AuthService.setPassword`; never read back out of the
     * API — only the `hasPassword` boolean is exposed.
     */
    passwordHash: text('password_hash'),
    /**
     * True while the credential on the account is a temporary one. The person can sign in and can
     * do nothing else until they replace it: the API refuses every other route and the client
     * holds them on /change-password.
     */
    mustChangePassword: boolean('must_change_password').notNull().default(false),
    mfaEnabled: boolean('mfa_enabled').notNull().default(false),
    locale: text('locale').notNull().default('en'),
    /** Light / Dark / System for the product's look; the worker's own, not the company's. */
    appearance: text('appearance').notNull().default('system'),
    isActive: boolean('is_active').notNull().default(true),
    /** May create and look after customer companies (the Companies page). The person's, not a company's. */
    isPlatformAdmin: boolean('is_platform_admin').notNull().default(false),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_key').on(sql`lower(${table.email})`)],
);

export const memberships = pgTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The workforce record this account belongs to, when there is one. Optional both ways. */
    employeeId: text('employee_id').references(() => employees.id),
    /** invited · active · suspended · disabled */
    status: text('status').notNull().default('invited'),
    /** The last account that cannot be locked out of its own company. */
    isOwner: boolean('is_owner').notNull().default(false),
    invitedByUserId: text('invited_by_user_id'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    invitationExpiresAt: timestamp('invitation_expires_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    /** When the person submitted Complete your profile (0077). */
    profileCompletedAt: timestamp('profile_completed_at', { withTimezone: true }),
    /**
     * The roster driver this membership signs in as (0081, the driver app). Set only through
     * POST /drivers/:id/app-access; unique per company. A membership with a driver id is a driver
     * login: it holds the driver role only and never office permissions (demo-principal.middleware).
     */
    driverId: text('driver_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_company_user_key').on(table.companyId, table.userId),
    // One account per employee: two logins for one person is how access outlives employment.
    uniqueIndex('memberships_employee_key')
      .on(table.employeeId)
      .where(sql`${table.employeeId} is not null`),
    index('memberships_company_status_idx').on(table.companyId, table.status),
    uniqueIndex('memberships_company_driver_key')
      .on(table.companyId, table.driverId)
      .where(sql`${table.driverId} is not null`),
  ],
);

// ========================================================================================= rbac

export const roles = pgTable(
  'roles',
  {
    id: text('id').primaryKey(),
    /** Null for a role the product ships with; those are shared and cannot be edited. */
    companyId: text('company_id').references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    isSystem: boolean('is_system').notNull().default(false),
    /** active · archived */
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('roles_scope_code_key').on(sql`coalesce(${table.companyId}, 'system')`, table.code),
  ],
);

export const permissions = pgTable(
  'permissions',
  {
    code: text('code').primaryKey(),
    module: text('module').notNull(),
    groupName: text('group_name').notNull(),
    action: text('action').notNull(),
    description: text('description').notNull(),
  },
  (table) => [index('permissions_module_idx').on(table.module)],
);

export const rolePermissions = pgTable(
  'role_permissions',
  {
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
    permissionCode: text('permission_code')
      .notNull()
      .references(() => permissions.code, { onDelete: 'cascade' }),
  },
  (table) => [uniqueIndex('role_permissions_key').on(table.roleId, table.permissionCode)],
);

export const membershipRoles = pgTable(
  'membership_roles',
  {
    membershipId: text('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'cascade' }),
    roleId: text('role_id')
      .notNull()
      .references(() => roles.id, { onDelete: 'restrict' }),
    assignedByName: text('assigned_by_name'),
    assignedAt: timestamp('assigned_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('membership_roles_key').on(table.membershipId, table.roleId)],
);

// ================================================================================== departments

export const departments = pgTable(
  'departments',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    managerEmployeeId: text('manager_employee_id').references(() => employees.id),
    parentDepartmentId: text('parent_department_id'),
    /** active · inactive */
    status: text('status').notNull().default('active'),
    /** True for the seven the workforce already uses; renaming one would orphan employee rows. */
    isSystem: boolean('is_system').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('departments_company_code_key').on(table.companyId, table.code),
    uniqueIndex('departments_company_name_key').on(table.companyId, sql`lower(${table.name})`),
    index('departments_company_status_idx').on(table.companyId, table.status),
  ],
);

// ===================================================================================== settings

/**
 * Company configuration as key/value, per `docs/DATABASE.md` §3.2.
 *
 * Key/value rather than a wide table because settings arrive one at a time over years and a
 * migration per checkbox is not a system anybody maintains. Each key's shape is validated by the
 * shared settings contract before it is written.
 */
export const settings = pgTable(
  'settings',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedByName: text('updated_by_name'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('settings_company_key_key').on(table.companyId, table.key)],
);

// ================================================================================= integrations

/**
 * A connection to an external system.
 *
 * `credentials` holds whatever the provider needs. It is **never** selected by the list or detail
 * queries — only the connect operation writes it, and nothing reads it back to a client. The API
 * returns a masked hint (`••••••••abcd`) computed at write time and stored separately, so a leak
 * would have to be deliberate rather than accidental.
 */
export const integrationAccounts = pgTable(
  'integration_accounts',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    category: text('category').notNull(),
    name: text('name').notNull(),
    /** not_configured · connected · error · disabled */
    status: text('status').notNull().default('not_configured'),
    config: jsonb('config')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Never returned by any endpoint. */
    credentials: jsonb('credentials'),
    /** Last four characters of the credential, for recognising which key is in place. */
    credentialHint: text('credential_hint'),
    credentialUpdatedAt: timestamp('credential_updated_at', { withTimezone: true }),
    /** What the provider calls the organisation behind the token, once it has answered. */
    externalName: text('external_name'),
    lastSyncAt: timestamp('last_sync_at', { withTimezone: true }),
    lastSuccessAt: timestamp('last_success_at', { withTimezone: true }),
    lastError: text('last_error'),
    /** The counts from the last run, so the account can say what it did without a join. */
    lastSummary: jsonb('last_summary'),
    errorCount: integer('error_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  // Not unique: two Samsara organisations under one carrier are two rows, each with its own token.
  (table) => [index('integration_accounts_company_provider_idx').on(table.companyId, table.provider)],
);

export const integrationSyncRuns = pgTable(
  'integration_sync_runs',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    integrationAccountId: text('integration_account_id')
      .notNull()
      .references(() => integrationAccounts.id, { onDelete: 'cascade' }),
    direction: text('direction').notNull(),
    entity: text('entity').notNull(),
    status: text('status').notNull(),
    records: integer('records').notNull().default(0),
    durationMs: integer('duration_ms'),
    error: text('error'),
    /** What the run did, by bucket. Counts only. */
    summary: jsonb('summary'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('integration_sync_runs_account_idx').on(table.integrationAccountId, table.startedAt),
  ],
);

// ==================================================================================== workflows

export const workflowRules = pgTable(
  'workflow_rules',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    description: text('description'),
    /** The audit action + entity type this rule listens for, e.g. `employee:status_change`. */
    trigger: text('trigger').notNull(),
    conditions: jsonb('conditions')
      .notNull()
      .default(sql`'[]'::jsonb`),
    actions: jsonb('actions')
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** draft · active · paused · disabled */
    status: text('status').notNull().default('draft'),
    runCount: integer('run_count').notNull().default(0),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    ownerName: text('owner_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('workflow_rules_company_name_key').on(table.companyId, table.name),
    index('workflow_rules_company_trigger_idx').on(table.companyId, table.trigger, table.status),
  ],
);

export const workflowRuns = pgTable(
  'workflow_runs',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    ruleId: text('rule_id')
      .notNull()
      .references(() => workflowRules.id, { onDelete: 'cascade' }),
    /** The audit entry that triggered this run. Also the idempotency key. */
    triggerAuditId: text('trigger_audit_id'),
    triggerSummary: text('trigger_summary'),
    /** matched · skipped · failed */
    status: text('status').notNull(),
    /** Why it did not run, when it was skipped. Never silent. */
    skipReason: text('skip_reason'),
    steps: jsonb('steps')
      .notNull()
      .default(sql`'[]'::jsonb`),
    durationMs: integer('duration_ms'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('workflow_runs_rule_idx').on(table.ruleId, table.startedAt),
    // One run per rule per triggering event: a retry cannot double-fire an action.
    uniqueIndex('workflow_runs_idempotency_key')
      .on(table.ruleId, table.triggerAuditId)
      .where(sql`${table.triggerAuditId} is not null`),
  ],
);

// ================================================================================ notifications

export const notifications = pgTable(
  'notifications',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    recipientUserId: text('recipient_user_id').references(() => users.id),
    severity: text('severity').notNull().default('info'),
    title: text('title').notNull(),
    body: text('body'),
    entityType: text('entity_type'),
    entityId: text('entity_id'),
    /** system · workflow · ai · user */
    source: text('source').notNull().default('system'),
    dedupeKey: text('dedupe_key'),
    readAt: timestamp('read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('notifications_company_idx').on(table.companyId, table.createdAt),
    uniqueIndex('notifications_dedupe_key')
      .on(table.companyId, table.dedupeKey)
      .where(sql`${table.dedupeKey} is not null`),
  ],
);

// ================================================================================ auth sessions

/**
 * A signed-in session.
 *
 * Only the SHA-256 of the bearer token is stored, so a dump of this table cannot be replayed as a
 * login. The session, not the browser, is the source of truth: revoking a row signs the person out
 * everywhere, and an expired row is refused even if the browser still holds the token.
 */
export const authSessions = pgTable(
  'auth_sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id),
    membershipId: text('membership_id')
      .notNull()
      .references(() => memberships.id),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id),
    tokenHash: text('token_hash').notNull(),
    userAgent: text('user_agent'),
    ip: text('ip'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    /** web (12 h) · mobile (30 days); null = web (0081). */
    client: text('client'),
  },
  (table) => [
    uniqueIndex('auth_sessions_token_key').on(table.tokenHash),
    index('auth_sessions_user_idx').on(table.userId, table.expiresAt),
  ],
);

// ==================================================================================== relations

export const membershipRelations = relations(memberships, ({ one, many }) => ({
  user: one(users, { fields: [memberships.userId], references: [users.id] }),
  employee: one(employees, { fields: [memberships.employeeId], references: [employees.id] }),
  roles: many(membershipRoles),
}));

export const roleRelations = relations(roles, ({ many }) => ({
  permissions: many(rolePermissions),
  assignments: many(membershipRoles),
}));

export type UserRow = typeof users.$inferSelect;
export type MembershipRow = typeof memberships.$inferSelect;
export type RoleRow = typeof roles.$inferSelect;
export type DepartmentRow = typeof departments.$inferSelect;
export type SettingRow = typeof settings.$inferSelect;
export type IntegrationAccountRow = typeof integrationAccounts.$inferSelect;
export type WorkflowRuleRow = typeof workflowRules.$inferSelect;
export type WorkflowRunRow = typeof workflowRuns.$inferSelect;
export type AuthSessionRow = typeof authSessions.$inferSelect;
