# NEWAY TMS — Authentication and Role-Based Access Control

Related: [ARCHITECTURE.md](../ARCHITECTURE.md) · [MULTI_TENANCY.md](MULTI_TENANCY.md) · [DATABASE.md](DATABASE.md)

---

## 1. Authentication

### 1.1 Credentials and sessions

- Passwords hashed with argon2id (memory 64 MB, iterations 3). Policy: 12+ characters, breached-password check, rotation forced after admin reset.
- Login: `POST /auth/login {email, password}` → if MFA enabled, `mfa_required` challenge → `POST /auth/mfa {code}`. On success a **session row** is created and two cookies are set: `access` (JWT, 15 min: `sid`, `uid`, `mid` active membership, `cid` company, `pv` permission version) and `refresh` (opaque, 7 days, rotated on every use; reuse of a rotated token revokes the whole session family). Cookies are `HttpOnly; Secure; SameSite=Lax; Path=/`.
- `Authorization: Bearer <access>` is accepted for non-browser clients. API keys use `X-Api-Key`.
- Sessions are visible and revocable: a user sees their own; company admins see all sessions of their company's members (device, IP, last seen); platform admins see platform sessions. "Who is logged in" is `sessions.last_seen_at` within the last N minutes.
- Lockout after 10 failed attempts in 15 minutes (per account and per IP); login rate limit; every attempt audited.
- MFA (TOTP) optional for everyone; **mandatory** for platform users, company owners, and company admins. Recovery codes issued once.
- Password reset by emailed single-use link (30 min). Invitations are single-use links that create the membership on acceptance.
- Public tokenized links (`public_links`): driver document upload, load tracking share, e-sign. Scoped to one entity and purpose, expiring, use-counted, rate-limited, revocable.

### 1.2 Principals

| Principal | Source | Context |
|---|---|---|
| Company member | `sessions` → `memberships` | `companyId`, roles, permissions |
| Platform user | `sessions` (platform) | no company; or a support session's company |
| API key | `api_keys` | `companyId`, explicit permission list |
| Driver | membership with the Driver role (portal) | own records only |
| System / automation / AI | internal principals created by the worker, not by login | permissions of the `automation` role, plus approval requirements |

---

## 2. Permissions

A permission is `module.action`. The registry lives in `packages/shared/src/permissions.ts` and is seeded into `permissions` on migration. A route that declares no permission fails at startup; a test enumerates every route and asserts each has one.

### 2.1 Actions

| Action | Meaning |
|---|---|
| `view` | Read lists and details (without money/PII unless also granted) |
| `create` | Create records |
| `edit` | Update non-financial fields |
| `delete` | Soft delete / cancel / void (never physical delete of transactional data) |
| `assign` | Assign drivers/trucks/trailers/dispatchers/tasks |
| `approve` | Approve requests, AI/workflow actions, PTO, repair orders |
| `finalize` | Finalize/close money periods, settlements, invoices, payroll |
| `export` | Export/download reports and lists |
| `manage` | Configure the module (types, rules, settings) |
| `view_financial` | See money fields in this module (rates, costs, pay) |
| `view_pii` | See personal identifiers (SSN, CDL number, home address, bank) |
| `admin` | Administrative access to the module (users, roles, integrations, audit) |

### 2.2 Modules

`dashboard, dispatch, loads, tracking, drivers, trucks, trailers, customers, brokers, vendors, maintenance, fuel, safety, compliance, inspections, accidents, violations, accounting, invoices, receivables, payables, expenses, settlements, payroll, employees, recruiting, onboarding, attendance, pto, performance, documents, reports, analytics, notifications, workflows, ai, integrations, users, roles, departments, settings, audit`.

Not every module has every action; the registry lists the valid pairs (about 250 permissions).

### 2.3 Field-level financial and PII access

Response schemas mark fields as `financial` or `pii`. The response serializer blanks (`null`) marked fields when the principal lacks `<module>.view_financial` / `<module>.view_pii`. List endpoints apply the same masking. Query tools used by the AI apply it too. This is enforced in one place so a new endpoint cannot forget it.

### 2.4 Scopes

A role assignment (`membership_roles`) has a scope:

| Scope | Effect |
|---|---|
| `company` | All rows of the module |
| `department` | Rows linked to the department (e.g. tasks, employees) |
| `team` | Rows linked to the team (a dispatcher sees loads on their board; a dispatch manager with company scope sees all boards) |
| `self` | Own rows only (driver portal, employee self-service) |

Scope is applied inside services as an additional filter; it never replaces tenant isolation.

---

## 3. Roles

### 3.1 Platform roles (no company)

| Role | Can |
|---|---|
| Platform Super Admin | Everything on the platform: companies, plans, subscriptions, platform users, settings, health, integrations catalog, audit, analytics; open support sessions |
| Platform Support | View companies and health; open support sessions (read-only inside a company unless elevated per session) |
| Platform Billing | Plans, subscriptions, usage |
| Platform Read Only | Read platform screens |

### 3.2 Company roles (seeded; companies may clone and edit non-system roles)

| Role | Summary |
|---|---|
| Company Owner | Every permission in the company, including billing contact, deleting the company's data, and assigning Company Admin |
| Company Admin | All modules incl. users, roles, departments, integrations, workflows, settings, audit. Cannot remove the last owner |
| Executive | `view` + `view_financial` + `view_pii` everywhere; `approve` on AI/workflow actions; `export`; no `edit` on money modules |
| Operations Manager | Dispatch, loads, tracking, drivers, trucks, trailers, customers, brokers: full incl. `assign`, `view_financial`; safety/maintenance/fuel `view`; tasks `manage`; `approve` dispatch AI actions |
| Dispatch Manager | Dispatch/loads/tracking full (company scope), customers/brokers full, drivers/trucks/trailers `view`+`assign`, loads `view_financial`; `manage` load statuses; team management |
| Dispatcher | Dispatch/loads `view/create/edit/assign` with **team scope**, tracking `view`, drivers/trucks/trailers/customers/brokers `view`, documents `create`, notes; loads `view_financial` (rates) but **no** accounting, settlements, payroll, no `delete` on any money record, no settings |
| Safety Manager | Safety, compliance, inspections, accidents, violations: full incl. `manage`, holds; drivers `view/edit` (compliance fields), `view_pii`; documents; `approve` safety AI actions |
| Safety Specialist | Safety/compliance/inspections/accidents/violations `view/create/edit`, drivers `view`, `view_pii`; cannot release holds or `manage` |
| Fleet Manager | Trucks, trailers, maintenance, fuel, vendors: full incl. `manage`, `view_financial`; payables `create` (bills from repair orders); `approve` maintenance AI actions |
| Maintenance Manager | Maintenance full, trucks/trailers `view/edit` (status), vendors `view/create`, parts/tires `manage`, `view_financial` for maintenance |
| Accounting Manager | Accounting, invoices, receivables, payables, expenses, settlements, payroll: full incl. `finalize`, `manage`, `view_financial`; loads `view`+`view_financial`; reports `export`; ledger period close |
| Accountant | Invoices/receivables/payables/expenses `view/create/edit`, settlements `view/create`; **no** `finalize`, no payroll `finalize`, no `delete` |
| HR Manager | Employees, recruiting, onboarding, attendance, PTO, performance: full incl. `manage`, `view_pii`, compensation edit; payroll `view/create` (inputs) but not `finalize` |
| HR Specialist | HR modules `view/create/edit`, `view_pii`; no compensation edit, no `manage` |
| Recruiter | Recruiting full, onboarding `create`, drivers `create` (on hire), documents `create`; nothing else |
| Driver | `self` scope: own profile `view/edit` (contact fields), own loads `view` + status/document updates from the portal, own documents `create/view`, own settlements `view` |
| Read Only | `view` on all operational modules; no financial, no PII, no export |
| Automation (system) | Assigned to workflows/AI: `create` tasks/alerts/notifications, `edit` internal ETA and flags, `assign` when approved, never `finalize`/`delete`/settings |

The exact matrix is generated from the registry into `docs/generated/permissions-matrix.md` in Phase 3 so it cannot drift from code.

### 3.3 Administrative delegation rules

- Only an Owner can grant Owner or Admin. An Admin can grant any non-admin role.
- Nobody can grant a permission they do not hold themselves (no escalation by editing roles).
- System roles are immutable; a company customizes by cloning.
- Removing the last active Owner is refused.
- Role changes take effect on the next request: the access token carries `pv` (permission version); a role edit bumps the company's permission version and invalidates cached permission sets.

---

## 4. Enforcement layers

| Layer | Where | What it does |
|---|---|---|
| Route guard | `@RequirePermission('loads.edit')` on every controller method | Rejects with 403 before the handler runs |
| Service check | `authorize(ctx, 'loads.edit', load)` for row-level rules (scope, ownership, state) | Protects service methods called from workflows, AI, jobs, or other modules |
| Query scope | Repository helpers apply `team`/`department`/`self` filters | Lists never include out-of-scope rows |
| Serializer | Financial/PII masking | Same rule on every response and every AI tool result |
| UI | `usePermission('loads.edit')` hides or disables controls; sidebar built from `view` permissions | Convenience only; never relied on |

Every 403 is logged with principal, permission, route, and entity id, and surfaced in the audit stream for admins.

---

## 5. Audit log

Every state-changing service method records:

```
at, actor_type (user | platform_user | api_key | workflow | ai | system | integration), actor_id, actor_name,
action (create | update | delete | status_change | assign | approve | reject | finalize | reverse | login | logout | export | permission_change | …),
entity_type, entity_id, entity_label,
changes: [{ field, old, new }],   -- field-level diffs, masked for pii fields unless the reader has view_pii
summary: "John Smith changed Load L-1234 status from In Transit to Delivered",
request_id, ip, user_agent, via_support_session
```

Audit is append-only; the application database role has no `UPDATE`/`DELETE` on `audit_logs`. Reads require `audit.view`; PII in diffs requires `audit.view_pii`.

---

## 6. Tests required (Phase 3 onward)

- Every route has a permission; unknown permission code fails startup.
- Role matrix test: for each seed role, each endpoint returns the expected allow/deny.
- Scope tests: dispatcher with team scope sees only team loads; driver sees only self.
- Masking tests: accountant sees rates; dispatcher without `view_financial` on settlements sees `null`; read-only never sees PII.
- Escalation tests: admin cannot grant owner; role editor cannot add permissions they lack; last owner cannot be removed.
- Automation tests: workflow/AI principal cannot finalize, delete, or change settings; actions marked `require_approval` are blocked until an approver with the right permission approves.
- Session tests: refresh rotation, reuse detection, revoke, lockout, MFA enforcement for admin roles.
