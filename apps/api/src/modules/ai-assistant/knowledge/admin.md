# Administration

The Administration menu is where a company administrator manages who can sign in (Users), the staff records (Employees), what each role may do (Roles & Permissions), the department structure, connections to outside systems (Integrations), automation rules (Workflows), the audit trail (Audit Logs) and company configuration (Settings). Companies is only for the platform (grand) administrator who opens new customer companies.

## Add a user account (Users & access)

Path: Administration › Users (/admin/users) · Permission: users.view
Needs to change: users.create

What it is for: creates a login for a person in this company. There is no self sign-up and no invitation email: you give the person a temporary password yourself.

Steps
1. Open Administration › Users. The cards show "Total accounts", "Active", "Invited", "Suspended", "Disabled".
2. Press "Add account".
3. Fill "First name" and "Last name" (required), "Email" (the sign-in identity, unique across the platform), optional "Phone".
4. Tick at least one role under "Roles". "An account with no role signs in and is refused by every screen."
5. Press "Create account". A "Temporary password" window shows the password once ("This password will only be shown now. Store it securely and provide it to the user."). Press "Copy", give it to the person, then "Done".
6. The account is "Invited" until the person signs in for the first time; then it becomes "Active". At first sign-in they must choose their own password.

Adding a person who already works in another company: use their existing email. No password is created; you see "They already sign in to another company: same email and password. They switch company in the top bar."

Why it won't work
- "Create account" is grey with "Pick at least one role: an account without one can sign in and do nothing" - tick a role.
- "No invitation email will be sent" - mail is not set up; hand over the temporary password yourself.
- "... already has an account in this company" - the email is already here; find it in the list.
- "That employee already has an account. One person, one login." / "That employee is not on this workforce".
- No "Add account" button - you lack users.create.

## Reset a password or issue a temporary password

Path: Administration › Users (/admin/users) › row menu · Permission: users.view
Needs to change: users.edit

What it is for: a person forgot their password, or an invited account never received one. The login screen's "Forgot password?" only tells people to ask an administrator.

Steps
1. Find the person (search "Search name, email or employee number", or filter by status or role).
2. For an "Invited" account press "Issue password" in the Actions column. For others open the row menu and choose "Issue temporary password".
3. Copy the password from the "Temporary password" window and give it to the person. Every existing session of that person ends.
4. Or choose "Set a password by hand", type a "New password" (at least 10 characters) and "Repeat the password", then "Set password" / "Replace password". It is stored as a hash and can never be read back.
5. In both cases the person must choose their own password when they next sign in.

Why it won't work
- "Could not issue a temporary password" - the server refused; the description says why.
- "Use at least 10 characters." / "The two passwords do not match."
- No such menu items - you lack users.edit.

## Change roles, status, email or linked employee of a user

Path: Administration › Users (/admin/users) › "Manage" or row menu · Permission: users.view
Needs to change: users.assign (roles), users.edit (status, email, employee link)

What it is for: give or take away access, suspend or end an account, correct the sign-in email, or link the account to its employee record.

Steps
1. Press "Manage" (or "Open account") to see Status, "Linked employee", Invited, Accepted, "Last sign-in", "Two-factor", Roles, effective permissions and History.
2. Roles: row menu › "Change roles", tick roles, press "Save roles". A person's access is the sum of their roles.
3. Status: "Change status", pick a "New status" and an optional "Reason" (kept on the audit entry), then "Change status":
   - active: "Can sign in and use everything their roles allow."
   - suspended: "Temporarily blocked. Roles and history are kept."
   - disabled: "Access ended. Kept for the audit trail; never deleted."
   - archived: "Not needed. Hidden from the list, cannot sign in, kept for the audit trail and can be restored."
   Accounts are never deleted. To deactivate a user, choose suspended or disabled.
4. Email: "Change email", type the "New email" (the address they sign in with), save.
5. Employee: in the account panel press "Link" / "Change" next to "Linked employee" and pick an employee without an account and press "Save". A recruiter linked here sees their leads under Recruiting › My leads.

Why it won't work
- "That would disable this account and leave nobody able to manage accounts and roles. Give another active account an administrator role first." (or "...remove the last administrator...") - the company must always keep one active account with users.edit and roles.edit.
- "Already suspended" (or another status) - it already has that status.
- "Another account already signs in with that email."
- "This person also signs in to another company; they change their email themselves."
- "One of those roles does not exist in this company, or has been archived".

## Employees: add and manage employee records

Path: Administration › Employees (/hr/employees) · Permission: employees.view
Needs to change: employees.create (add), employees.edit (change, status)

What it is for: the staff list. An employee is the person; a user account is their login; a driver profile is their driving record. Headcount by status: "Total employees", "Active", "On leave", "Suspended", "Terminated".

Steps to add
1. Press "Add employee" (or the arrow for "Add dispatcher" / "Full employee form").
2. Fill "Full name" (first and last), "Department", "Title", "Hire date", "Primary phone" and "Email" (required). Optional: "Nickname", "Date of birth", "Passport / ID number", "Home address", "Status", "Employment type" (Full-Time, Part-Time, Contractor, Temporary), "Location", "Shift time", "Pay type" (Commission (KPI), Salary, Hourly) and rate, "Secondary phone (emergency)".
3. Press "Create employee" (or "Create dispatcher"). A dispatcher appears on every dispatcher picker at once.

Managing one employee
1. Click the row or "Open profile". Tabs include Overview, Employment, Role & organization, Documents, Compensation, Payroll, Safety, Operations, Activity, Recruiting, Onboarding, Attendance, PTO, Performance.
2. "Change role" moves them to another position, department or manager. "Deactivate", "Activate", "Terminate" and "Archive" change status. "Has an account" / "No account" shows whether they can sign in; the login is made on Administration › Users.

Why it won't work
- Create button grey - a required field is empty, the phone is shorter than 7 characters, or the email is not valid.
- "... is already the work email of another employee"
- "An employee who is ... cannot become ..." - that status change is not allowed.
- "A reason is required to record someone as ..."
- "N people report to ... Reassign them to another manager first."
- "Only a terminated employee can be archived"
- "This person is paid from the pay plan on their driver profile. Change it there, so there is only one rate."
- "Export is not built yet".

## Grant a permission with Roles & Permissions

Path: Administration › Roles & Permissions (/admin/roles) · Permission: roles.view
Needs to change: roles.edit

What it is for: a role is a set of permissions; accounts get roles. Every permission listed is checked by the server. Pages are hidden from anyone without their permission.

Steps
1. Pick the role on the left (each shows its number of permissions and accounts; "Built in" roles ship with the product: Administrator, Operations Manager, Dispatcher, Dispatch Lead, Safety Manager, Fleet Manager, Maintenance, Accounting, HR Manager, Driver Relations, Read only).
2. Press "Edit".
3. Tick the permission boxes. They are grouped by module and area; each shows its description and code (for example ai_assistant.use, company_profile.edit, dispatch_pay.view). Ticking an action automatically grants the matching "view".
4. Press "Save changes". Everyone holding the role gets it at once.
5. Editing a built-in role: "Saving makes this company's own version of ... Its accounts move onto it with your changes; other companies keep the original."
6. To give one person a permission without changing a shared role, make a new role and add it to that person on Administration › Users ("Change roles").

Why it won't work
- "Save changes" is grey - nothing changed, or the name is under 2 characters.
- "This is the only role granting account and role management to an active account. Removing those permissions would leave nobody able to administer the company."
- "Not a permission this system enforces: ..."
- No "Edit" button - you lack roles.edit.

## Create, duplicate or archive a role

Path: Administration › Roles & Permissions (/admin/roles) · Permission: roles.view
Needs to change: roles.create (new, duplicate), roles.archive (archive)

Steps
1. "New role": give a "Name" (required) and "Description", tick permissions, press "Create role".
2. "Duplicate" on a selected role opens the same form pre-filled ("Duplicate ...").
3. "Archive" (only on roles that are not built in) asks "Archive ...?" then "Archive role". It stops being assignable; nothing is deleted.

Why it won't work
- "A role with that name already exists" / "Give the role a name with letters in it".
- "N accounts hold this role. Move them to another role first — archiving it would silently remove their access."
- "... ships with the product and cannot be archived. Duplicate it to make a version you can change."

## Departments

Path: Administration › Departments (/admin/departments) · Permission: departments.view
Needs to change: departments.create, departments.edit (rename, manager, deactivate)

What it is for: the structure the workforce is organised by. Headcount comes from the employee records. The cards show "Departments", "People placed", "Empty departments".

Steps
1. "New department": "Code" (lowercase, permanent), "Name" (required), "Description", "Reports to" (or "Top level"), "Manager" (or "No manager"), then "Create department".
2. "Edit" on a department to rename it, change its parent, manager or "Status" (Active / Inactive), then "Save changes". Built-in departments keep their code; only the name can change.

Why it won't work
- "A department with the code ... already exists" / "A department named ... already exists".
- "N employees are still in .... Move them first." - a department with people cannot be deactivated.
- "A department cannot report to itself" / "That would make the department report to itself through its own chain".
- "That manager is not on this workforce".

## Integrations: connect Samsara, Relay, RTS, Twilio and email

Path: Administration › Integrations (/admin/integrations) · Permission: integrations.view
Needs to change: integrations.manage

What it is for: stores credentials for outside systems, one account per organisation (several accounts per provider are allowed). Working connectors: Samsara, Motive and Five ELD under "ELD & telematics" (vehicles, odometer and location, read only; see "Connect and sync Motive or Five ELD"), Relay (diesel and DEF fill-ups, read only), RTS Financial (FTPS) (invoice uploads), Twilio (SMS to drivers). Comdata, EFS, QuickBooks Online, DAT, Truckstop and Google Maps only store a key: "Would sync" and "Nothing will sync yet". Telegram is not set up here; it is configured on the server.

Steps
1. On the provider card press "Add account" (or "Add another").
2. Give an "Account name" and the required fields: Samsara "API token"; Relay "API key"; RTS "Client number (FTP username)", "Password", "Server", "Environment" (test or production; a test account uploads to the RTS test folder and marks nothing submitted); Twilio "Account SID", "Auth token", "Sender".
3. Press "Add account". Secrets are "Stored encrypted, never shown again"; only the last four characters show later.
4. On the account row: "Test" proves the key works (status becomes connected), "Sync" (Samsara, Relay), "Disable" / "Enable", "Replace" (or "Add key"), "Remove" (destroys the secret, keeps the account and its history).
5. The "Email" card shows the mail service; type an address and "Send a test email".

Why it won't work
- "Missing: ..." - a required field is empty.
- "No credential is stored for this account. Add one first."
- "... is disabled. Enable it before syncing."
- "The stored token cannot be read: it was sealed under a different server secret. Replace the credential."
- Buttons missing - you lack integrations.manage.

## Sync trucks from Samsara

Path: Administration › Integrations (/admin/integrations) › Samsara account › "Sync" · Permission: integrations.manage

What it is for: reads Samsara vehicles into the truck roster (odometer, engine hours, location). Nothing is ever written to Samsara.

Steps
1. Press "Sync" on the Samsara account row.
2. Optionally tick "Create trucks for vehicles the roster does not have" (only vehicles with a VIN and a recent odometer; inactive and duplicate vehicles are never created).
3. Press "Preview". "Preview — nothing changed" lists Updated, Created, Unmatched, Duplicates, Inactive, Conflicts and Unchanged.
4. Press "Apply" to make the changes. "Apply" is grey until a preview has run.

Why it won't work
- "Not synced" with "... has no credential stored. Add the API token first." / "No API token is stored."
- "... is disabled. Enable it before syncing."
- "... is a ... account; only Samsara has a connector."

## Connect and sync Motive or Five ELD

Path: Administration › Integrations (/admin/integrations) › "ELD & telematics" · Permission: integrations.view
Needs to change: integrations.manage

What it is for: Motive ("ELD, GPS and vehicle diagnostics.") and Five ELD ("ELD and GPS tracking (fiveeld.com).") feed the truck roster the same way Samsara does: vehicles, odometer and vehicle location (Motive also engine hours). Read only: nothing is ever written to Motive or Five ELD. Hours of service, driver logs and safety events are not synced.

Steps: add the account
1. On the "Motive" or "Five ELD" card press "Add account" (or "Add another").
2. Fill "Account name" ("Your name for it: which organisation, which yard.") and the provider fields:
   - Motive: "API key" (Motive dashboard → Admin → API keys (Fleet Admin); read access to vehicles and vehicle locations is enough).
   - Five ELD: "API key" (Five ELD dashboard (main company account) → More → API Keys → Add Key), "Provider token" (issued by Five ELD support, not the dashboard: email them the company name, USDOT and what the integration does) and "USDOT number" (the company USDOT as Five ELD knows it; not a secret). All three are required.
3. Press "Add account". Secrets are "Stored encrypted, never shown again". Status: "Credentials stored".

Steps: test and sync
1. On the account row press "Test". "<account> answered" means the key works and the status becomes "Connected"; "<account> did not connect" shows the reason.
2. Press "Sync". The window "Sync <account>" opens: "<provider> → the truck roster. Read-only against <provider>."
3. Optional: tick "Create trucks for vehicles the roster does not have" (only vehicles with a VIN and a recent odometer; inactive and duplicate vehicles are never created). Off by default.
4. Press "Preview". "Preview — nothing changed" shows "N vehicles read · N matched · N would update · N would be created · …" and tabs "Updated", "Created", "Unmatched", "Duplicates", "Inactive", "Conflicts", "Unchanged", one line per vehicle with the reason.
5. Press "Apply" (grey until a preview has run). Toast "<account> synced" with "N updated · N created". The row shows "Last sync <date> · N updated · N created · …".

How vehicles are matched: first by the vehicle linked in an earlier sync, then by VIN, then by unit number. An odometer never goes down: a reading more than 50 mi below the roster's is listed under "Conflicts" and not applied. A vehicle with no reading for 30 days is "Inactive" and skipped. A vehicle not in the roster is only listed under "Unmatched" unless the create box is ticked. A truck reported by two ELD accounts is kept on the one that reports it. Accounts with a key also sync by themselves every hour; the automatic sync never creates trucks.

Other buttons: "Enable" / "Disable", "Replace" (new key; Five ELD needs all three fields again), "Remove" (destroys the secret, keeps the account and its history).

Why it won't work
- No buttons: you lack integrations.manage.
- "Five ELD needs an API key, a provider token and the USDOT number. Replace the credential with all three."
- "<account> has no credential stored. Add the API key and provider token first." (Five ELD) / "… Add the API key first." (Motive)
- "<account> is disabled. Enable it before syncing."
- "The stored credential cannot be read: it was sealed under a different server secret. Replace the credential."
- "Motive kept answering "too many requests" (HTTP 429). Try again in a few minutes." (Five ELD says the same with its name.)
- A truck is under "Unmatched" with "Not in the roster and <provider> has no VIN for it, so it cannot be created": add the truck by hand or fix it in the ELD.

## Workflows (automation rules)

Path: Administration › Workflows (/admin/workflows) · Permission: workflows.view
Needs to change: workflows.create (new rule), workflows.edit (pause, activate)

What it is for: rules that react to a change recorded in the audit trail and notify everyone holding a role. Tabs "Rules" and "Run history"; counts of rules, active, runs, skipped and failed.

Steps
1. Press "New rule". Fill "Name" (required), "Description", "When" (an event the system records), optional "Only when" conditions, "Notify the role", optional "Notification title" and "Severity" (Info, Warning, Critical).
2. Press "Create rule". Use "Pause" / "Activate" on a rule.

Why it won't work
- "Create rule" is grey - name, event or role missing.
- "A rule with that name already exists" / "No such role: ...".
- A run is skipped with "Notifications are switched off in company settings." or "No active account holds the ... role, so there was nobody to notify."
- "Not every action is built" lists actions that do nothing yet.

## Audit Logs

Path: Administration › Audit Logs (/admin/audit-logs) · Permission: audit.view
Needs to export: audit.export

What it is for: every recorded change: "When", "Who", "Action", "Record", "What changed". "Records here cannot be changed": there is no way to edit or delete an entry.

Steps
1. Search "Search record, summary or person", filter by action ("Any action"), record type ("Any record type"), person ("Anyone"), and From / To dates.
2. Open an entry to see before and after values.
3. "Export CSV" downloads the filtered list (needs audit.export).

Why it won't work
- "Nothing matches" - widen the date range or clear a filter; changes made before the trail began are not in it.

## Settings (company configuration and truck types)

Path: Administration › Settings (/admin/settings) · Permission: settings.view
Needs to change: settings.edit

What it is for: company configuration. Each field says which part of the system reads it ("Read by: ..."), or "Nothing reads this yet".

Groups: "Company" (Company name), "Calendar & timezone" ("Operating timezone", "Reporting week starts"), "Automation" ("Run automation rules", "Create in-app notifications"), "Driver prequalification" (age 23 or older, minimum CDL years, minimum OTR experience, maximum accidents and moving violations in 36 months, DUI disqualifies, Clearinghouse consent employer name, consent before application), "Cost per hire — unit costs" (MVR, PSP report, Clearinghouse query, pre-employment drug test), "Retention" (audit retention days). Also "Truck types and oil-change intervals".

Steps
1. Change the fields, then "Save changes" ("Discard" undoes).
2. Truck types: "Add truck type", enter "Type" (for example Freightliner) and "Oil change every (mi)", then "Add type". Under "Which type each unit is" pick each unit's type, or "Fleet default".

Why it won't work
- "Not saved" with "One or more settings are not valid" or "Not a setting this system has: ...".
- "The interval is in miles, between 5,000 and 100,000." / "Name the truck type - Freightliner, Volvo, Kenworth…"
- Fields locked - you lack settings.edit.

## Companies (platform administrator only)

Path: Administration › Companies (/platform/companies) · Permission: platform administrator (grand admin) only; a company owner is not enough

What it is for: open new customer companies, each with its first administrator. Nothing is ever deleted.

Steps
1. "New company": "Company name", "Administrator email", "First name" (required), "Last name", then "Create company". The administrator gets a temporary password to change at first sign-in.
2. On a company row: "Rename", "New admin password", "Deactivate" (with a required "Reason"; "Nobody in ... can sign in until it is reactivated"), "Reactivate".

Why it won't work
- "Platform administrators only" / "Only a platform administrator can manage companies."
- "... already has an account. Use another email for this company's administrator."
- "A company called ... already exists."
- "You are signed in through this company. Deactivating it would lock you out."
- "This company has no owner administrator."
- "Someone changed this company a moment ago. Reload and try again."
