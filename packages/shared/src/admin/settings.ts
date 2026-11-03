import { z } from 'zod';

/**
 * Company settings.
 *
 * A settings screen full of switches that change nothing is the most expensive kind of lie: it
 * costs an administrator their trust in every other switch. So every entry in this registry
 * declares who reads it, and the two that nothing reads yet say so on the screen instead of
 * pretending.
 *
 * Two storage locations, deliberately:
 *
 *   `companies`  identity and the reporting calendar. These are on the company row because the
 *                request principal is built from it and every period resolution in the product
 *                already reads them. Moving them into key/value would mean a second lookup on
 *                every request to change nothing.
 *   `settings`   everything else, as key/value validated by the schema declared here.
 */

export const SETTING_GROUPS = [
  'company',
  'localization',
  'automation',
  'hiring',
  'hiring_costs',
  'people',
  'routing',
  'retention',
] as const;

/** Company setting: new accounts fill in their own employee information at first sign-in. */
export const SELF_PROFILE_SETTING = 'people.self_profile_required';
export type SettingGroup = (typeof SETTING_GROUPS)[number];

export interface SettingDefinition {
  key: string;
  group: SettingGroup;
  label: string;
  help: string;
  /** How the field is rendered. */
  kind: 'text' | 'select' | 'boolean' | 'number';
  options?: { value: string; label: string }[];
  /**
   * The code that reads this setting. `null` means nothing reads it yet — the value is stored and
   * audited, but it changes no behaviour, and the UI says so rather than implying it does.
   */
  enforcedBy: string | null;
  /** Why it is not enforced yet. Present exactly when `enforcedBy` is null. */
  notEnforcedReason?: string;
  /** Where the value lives. */
  storage: 'company' | 'settings';
  requiresPermission: string;
}

/** Timezones a US carrier operates in. Not the full IANA list — these are the ones that apply. */
export const CARRIER_TIMEZONES = [
  { value: 'America/New_York', label: 'Eastern — America/New_York' },
  { value: 'America/Chicago', label: 'Central — America/Chicago' },
  { value: 'America/Denver', label: 'Mountain — America/Denver' },
  { value: 'America/Phoenix', label: 'Mountain, no DST — America/Phoenix' },
  { value: 'America/Los_Angeles', label: 'Pacific — America/Los_Angeles' },
  { value: 'America/Anchorage', label: 'Alaska — America/Anchorage' },
  { value: 'Pacific/Honolulu', label: 'Hawaii — Pacific/Honolulu' },
];

export const WEEK_START_DAYS = [
  { value: 'sunday', label: 'Sunday' },
  { value: 'monday', label: 'Monday' },
  { value: 'saturday', label: 'Saturday' },
];

export const SETTINGS: SettingDefinition[] = [
  {
    key: 'company.name',
    group: 'company',
    label: 'Company name',
    help: 'Shown throughout the application and on exports.',
    kind: 'text',
    enforcedBy: 'Every screen header and report export',
    storage: 'company',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'company.timezone',
    group: 'localization',
    label: 'Operating timezone',
    help: 'Every "today", every reporting week and every period in the product is resolved in this zone. Changing it moves the boundaries of every report.',
    kind: 'select',
    options: CARRIER_TIMEZONES,
    enforcedBy: 'ReportingPeriodService — dashboard, reports and analytics',
    storage: 'company',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'company.week_start',
    group: 'localization',
    label: 'Reporting week starts',
    help: 'The first day of the reporting week. Settlements, dispatch weeks and the "this week" preset all follow it.',
    kind: 'select',
    options: WEEK_START_DAYS,
    enforcedBy: 'ReportingPeriodService — dashboard, reports and analytics',
    storage: 'company',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'automation.workflows_enabled',
    group: 'automation',
    label: 'Run automation rules',
    help: 'The master switch. Turning it off stops every active rule from firing without disabling the rules one by one.',
    kind: 'boolean',
    enforcedBy: 'WorkflowEngineService — checked before any rule is evaluated',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'automation.notifications_enabled',
    group: 'automation',
    label: 'Create in-app notifications',
    help: 'Whether workflow rules may raise notifications. Rules that would have notified record a skipped run with the reason, so nothing disappears silently.',
    kind: 'boolean',
    enforcedBy: 'WorkflowEngineService — the notify action',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  /*
   * Driver prequalification rules. Read by the lead prequalification evaluator: a lead whose
   * answers fail a rule is flagged with that rule named. A threshold left empty switches the rule
   * off; it does not lower it to zero.
   */
  {
    key: 'hiring.prequal.require_age_23',
    group: 'hiring',
    label: 'Require age 23 or older',
    help: 'Insurance minimum for most fleets. Stored as a yes/no answer, never a date of birth.',
    kind: 'boolean',
    enforcedBy: 'LeadsService.prequalify — flags the lead with this rule named',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'hiring.prequal.min_cdl_years',
    group: 'hiring',
    label: 'Minimum years holding a CDL',
    help: 'How long the CDL must have been held. Empty switches the rule off.',
    kind: 'number',
    enforcedBy: 'LeadsService.prequalify — flags the lead with this rule named',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'hiring.prequal.min_experience_years',
    group: 'hiring',
    label: 'Minimum verifiable OTR experience (years)',
    help: 'Empty switches the rule off.',
    kind: 'number',
    enforcedBy: 'LeadsService.prequalify — flags the lead with this rule named',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'hiring.prequal.max_accidents_36mo',
    group: 'hiring',
    label: 'Maximum accidents in the last 36 months',
    help: 'Self-reported on the first call; the MVR check confirms it later. Empty switches the rule off.',
    kind: 'number',
    enforcedBy: 'LeadsService.prequalify — flags the lead with this rule named',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'hiring.prequal.max_violations_36mo',
    group: 'hiring',
    label: 'Maximum moving violations in the last 36 months',
    help: 'Empty switches the rule off.',
    kind: 'number',
    enforcedBy: 'LeadsService.prequalify — flags the lead with this rule named',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'hiring.prequal.dui_disqualifies',
    group: 'hiring',
    label: 'A DUI disqualifies',
    help: 'Ever, not within a window: most insurers will not cover the driver at any point.',
    kind: 'boolean',
    enforcedBy: 'LeadsService.prequalify — flags the lead with this rule named',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'hiring.clearinghouse_employer_name',
    group: 'hiring',
    label: 'Employer name on the Clearinghouse consent',
    help: 'The legal name the driver gives limited-query consent to, exactly as registered in the FMCSA Clearinghouse (e.g. "NORTHWIND FREIGHT INC."). Empty: the company name.',
    kind: 'text',
    enforcedBy: 'ConsentService — fills (Company Name) in the FMCSA sample limited consent',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'hiring.consent_first',
    group: 'hiring',
    label: 'Consent and Safety before the application',
    help: 'On: the driver signs the consent, Safety approves, and only then is the application link sent (the recruiting journey). Off: the application can go out first, as before.',
    kind: 'boolean',
    enforcedBy: 'RecruitService.assertApplicationAllowed — refuses the application link until Safety approves',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  /**
   * Unit costs. Filled into the cost ledger the moment a check's report is filed in the
   * qualification file, so cost per hire never waits on someone typing the invoice in.
   */
  {
    key: 'hiring.cost.mvr',
    group: 'hiring_costs',
    label: 'MVR ($)',
    help: 'Charged when a motor vehicle record is filed for a candidate.',
    kind: 'number',
    enforcedBy: 'CostLedgerService — pre-fills the cost entry when the report is filed',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'hiring.cost.psp',
    group: 'hiring_costs',
    label: 'PSP report ($)',
    help: 'Charged when a PSP report is filed for a candidate.',
    kind: 'number',
    enforcedBy: 'CostLedgerService — pre-fills the cost entry when the report is filed',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'hiring.cost.clearinghouse',
    group: 'hiring_costs',
    label: 'Clearinghouse query ($)',
    help: 'Charged when a Clearinghouse query result is filed for a candidate.',
    kind: 'number',
    enforcedBy: 'CostLedgerService — pre-fills the cost entry when the report is filed',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'hiring.cost.drug_test',
    group: 'hiring_costs',
    label: 'Pre-employment drug test ($)',
    help: 'Charged when a drug test result is filed for a candidate.',
    kind: 'number',
    enforcedBy: 'CostLedgerService — pre-fills the cost entry when the report is filed',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'referral.bonus_amount',
    group: 'hiring',
    label: 'Driver referral bonus ($)',
    help: 'The bonus a driver is told about when they refer someone from the driver app. Not set, or 0, and the app shows no amount.',
    kind: 'number',
    enforcedBy: 'Driver app — GET /driver/referrals shows this amount',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'people.self_profile_required',
    group: 'people',
    label: 'New accounts complete their own profile',
    help: 'On: somebody given an account fills in their own employee information (name, contact, shift, date of birth, ID) the first time they sign in, before anything else opens. Department, title, role and pay stay with HR. Administrators are never asked. The Users page shows who has not finished.',
    kind: 'boolean',
    enforcedBy: 'AuthenticatedGuard — refuses every other route until the profile is submitted',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  /*
   * Route options (owner, 2026-10-27): TollGuru prices each road's fuel with these, so the
   * cheapest road is cheapest for this fleet's trucks, not an average car.
   */
  {
    key: 'routing.fuel_price_per_gallon',
    group: 'routing',
    label: 'Diesel price ($ per gallon)',
    help: 'What a gallon of diesel costs the fleet. Route options after Create load price each road’s fuel with it.',
    kind: 'number',
    enforcedBy: 'RouteOptionsService — fuel cost of every TollGuru route option',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'routing.truck_mpg',
    group: 'routing',
    label: 'Truck fuel economy (miles per gallon)',
    help: 'Average miles per gallon of the fleet’s trucks, loaded. Used with the diesel price for each road’s fuel cost.',
    kind: 'number',
    enforcedBy: 'RouteOptionsService — fuel cost of every TollGuru route option',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
  {
    key: 'retention.audit_days',
    group: 'retention',
    label: 'Audit retention (days)',
    help: 'How long audit records should be kept.',
    kind: 'number',
    enforcedBy: null,
    notEnforcedReason:
      'Nothing deletes audit records. There is no purge job, and audit history is currently kept indefinitely — this value is stored for when one exists.',
    storage: 'settings',
    requiresPermission: 'settings.edit',
  },
];

export const SETTING_KEYS = SETTINGS.map((s) => s.key);

/** Per-key value validation. A key absent from here cannot be written. */
export const SETTING_SCHEMAS: Record<string, z.ZodType> = {
  'company.name': z.string().trim().min(2).max(120),
  'company.timezone': z.enum(CARRIER_TIMEZONES.map((t) => t.value) as [string, ...string[]]),
  'company.week_start': z.enum(WEEK_START_DAYS.map((d) => d.value) as [string, ...string[]]),
  'automation.workflows_enabled': z.boolean(),
  'automation.notifications_enabled': z.boolean(),
  'retention.audit_days': z.number().int().min(30).max(3650),
  'hiring.prequal.require_age_23': z.boolean(),
  'hiring.prequal.min_cdl_years': z.number().min(0).max(30).nullable(),
  'hiring.prequal.min_experience_years': z.number().min(0).max(30).nullable(),
  'hiring.prequal.max_accidents_36mo': z.number().int().min(0).max(20).nullable(),
  'hiring.prequal.max_violations_36mo': z.number().int().min(0).max(20).nullable(),
  'hiring.prequal.dui_disqualifies': z.boolean(),
  'hiring.consent_first': z.boolean(),
  'people.self_profile_required': z.boolean(),
  'hiring.clearinghouse_employer_name': z.string().trim().min(2).max(160).nullable(),
  'hiring.cost.mvr': z.number().min(0).max(1000),
  'hiring.cost.psp': z.number().min(0).max(1000),
  'hiring.cost.clearinghouse': z.number().min(0).max(1000),
  'hiring.cost.drug_test': z.number().min(0).max(1000),
  'referral.bonus_amount': z.number().min(0).max(100000),
  'routing.fuel_price_per_gallon': z.number().min(0.5).max(20),
  'routing.truck_mpg': z.number().min(2).max(20),
};

/** Values used when a company has never set a key. */
export const SETTING_DEFAULTS: Record<string, unknown> = {
  'automation.workflows_enabled': true,
  'automation.notifications_enabled': true,
  'retention.audit_days': 2555,
  'hiring.prequal.require_age_23': true,
  'hiring.prequal.min_cdl_years': 2,
  'hiring.prequal.min_experience_years': 2,
  'hiring.prequal.max_accidents_36mo': 2,
  'hiring.prequal.max_violations_36mo': 3,
  'hiring.prequal.dui_disqualifies': true,
  'hiring.consent_first': true,
  'people.self_profile_required': true,
  'hiring.clearinghouse_employer_name': null,
  'hiring.cost.mvr': 18,
  'hiring.cost.psp': 10,
  'hiring.cost.clearinghouse': 1.25,
  'hiring.cost.drug_test': 65,
  'referral.bonus_amount': null,
  'routing.fuel_price_per_gallon': 3.75,
  'routing.truck_mpg': 6.5,
};

export const UpdateSettingsSchema = z.object({
  values: z.record(z.string(), z.unknown()),
});

export const SettingValueSchema = z.object({
  key: z.string(),
  value: z.unknown(),
  updatedByName: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type SettingValue = z.infer<typeof SettingValueSchema>;

export function settingDefinition(key: string): SettingDefinition | undefined {
  return SETTINGS.find((s) => s.key === key);
}
