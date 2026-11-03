import { z } from 'zod';
import { DRIVER_TYPES } from '../roster/roster.js';
import { EMPLOYEE_DEPARTMENTS, EMPLOYMENT_TYPES } from '../people/employee.js';
import { ONBOARDING_CATEGORIES, type TemplateItemSeed } from './onboarding.js';

/**
 * Onboarding templates, and the gate they put on a hired driver.
 *
 * A template is the plan a kind of hire gets: one per driver type, because a lease operator signs a
 * lease and a company driver does not, and one for office hires. An item can be **blocking** — the
 * driver is not an active driver until it is done, whatever the roster says — and can be **linked
 * to a qualification-file requirement**, in which case it is never ticked by hand: it completes
 * when the file holds the verified document, and reads "from the qualification file". That is the
 * road test certificate, the CDL, the medical card: one truth, in the file, reflected here.
 */

export const ONBOARDING_OWNER_ROLES = [
  'recruiter',
  'safety',
  'dispatch',
  'accounting',
  'hr',
  'driver',
] as const;
export const OnboardingOwnerRoleSchema = z.enum(ONBOARDING_OWNER_ROLES);
export type OnboardingOwnerRole = z.infer<typeof OnboardingOwnerRoleSchema>;

export const ONBOARDING_OWNER_ROLE_LABELS: Readonly<Record<OnboardingOwnerRole, string>> = {
  recruiter: 'Recruiter',
  safety: 'Safety',
  dispatch: 'Dispatch',
  accounting: 'Accounting',
  hr: 'HR',
  driver: 'The driver',
};

export const OnboardingTemplateItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(ONBOARDING_CATEGORIES),
  dueOffsetDays: z.number().int(),
  sortOrder: z.number().int(),
  /** Holds the driver at Hired until done. */
  blocking: z.boolean(),
  ownerRole: OnboardingOwnerRoleSchema.nullable(),
  /** Completed from the qualification file, never by hand. */
  requirementCode: z.string().nullable(),
});
export type OnboardingTemplateItem = z.infer<typeof OnboardingTemplateItemSchema>;

export const OnboardingTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  position: z.string().nullable(),
  department: z.enum(EMPLOYEE_DEPARTMENTS).nullable(),
  employmentType: z.enum(EMPLOYMENT_TYPES).nullable(),
  /** Which driver type this plan is for; null for office hires or any driver. */
  driverType: z.enum(DRIVER_TYPES).nullable(),
  isDefault: z.boolean(),
  items: z.array(OnboardingTemplateItemSchema),
});
export type OnboardingTemplate = z.infer<typeof OnboardingTemplateSchema>;

// -------------------------------------------------------------------------------------- seeds

export interface TemplateSeed {
  name: string;
  position: string | null;
  department: (typeof EMPLOYEE_DEPARTMENTS)[number] | null;
  driverType: (typeof DRIVER_TYPES)[number] | null;
  isDefault: boolean;
  items: TemplateItemSeed[];
}

const DRIVER_COMMON: TemplateItemSeed[] = [
  {
    title: 'DOT application on file',
    category: 'compliance',
    dueOffsetDays: 0,
    blocking: true,
    ownerRole: 'recruiter',
    requirementCode: 'dot_application',
  },
  {
    title: 'CDL verified and on file',
    category: 'compliance',
    dueOffsetDays: 0,
    blocking: true,
    ownerRole: 'safety',
    requirementCode: 'cdl',
  },
  {
    title: 'Medical certificate on file',
    category: 'compliance',
    dueOffsetDays: 0,
    blocking: true,
    ownerRole: 'safety',
    requirementCode: 'medical_card',
  },
  {
    title: 'Road test certificate filed',
    category: 'compliance',
    dueOffsetDays: 0,
    blocking: true,
    ownerRole: 'safety',
    requirementCode: 'road_test',
  },
  {
    title: 'Drug and alcohol policy signed',
    category: 'paperwork',
    dueOffsetDays: 1,
    blocking: true,
    ownerRole: 'safety',
  },
  {
    title: 'Employee handbook acknowledged',
    category: 'paperwork',
    dueOffsetDays: 2,
    blocking: false,
    ownerRole: 'hr',
  },
  {
    title: 'Direct deposit set up',
    category: 'payroll',
    dueOffsetDays: 3,
    blocking: false,
    ownerRole: 'accounting',
  },
  {
    title: 'ELD / Samsara driver account created',
    category: 'systems',
    dueOffsetDays: 1,
    blocking: true,
    ownerRole: 'dispatch',
  },
  {
    title: 'Fuel card issued',
    category: 'equipment',
    dueOffsetDays: 2,
    blocking: true,
    ownerRole: 'accounting',
  },
  {
    title: 'Truck assigned',
    category: 'equipment',
    dueOffsetDays: 2,
    blocking: true,
    ownerRole: 'dispatch',
  },
  {
    title: 'Safety and defensive driving training',
    category: 'training',
    dueOffsetDays: 14,
    blocking: false,
    ownerRole: 'safety',
  },
];

const W2: TemplateItemSeed = {
  title: 'W-4 completed (W-2 employee)',
  category: 'paperwork',
  dueOffsetDays: 1,
  blocking: true,
  ownerRole: 'accounting',
};
const W9: TemplateItemSeed = {
  title: 'W-9 on file (contractor)',
  category: 'paperwork',
  dueOffsetDays: 1,
  blocking: true,
  ownerRole: 'accounting',
};

/** The plans the seed installs and the hire event picks from. */
export const DRIVER_ONBOARDING_TEMPLATES: readonly TemplateSeed[] = [
  {
    name: 'Company driver',
    position: 'Driver',
    department: 'dispatch',
    driverType: 'company',
    isDefault: true,
    items: [W2, ...DRIVER_COMMON],
  },
  {
    name: 'Owner-operator',
    position: 'Driver',
    department: 'dispatch',
    driverType: 'owner_operator',
    isDefault: false,
    items: [
      W9,
      {
        title: 'Operating agreement signed',
        category: 'paperwork',
        dueOffsetDays: 0,
        blocking: true,
        ownerRole: 'recruiter',
      },
      {
        title: 'Equipment inspection and insurance certificate on file',
        category: 'equipment',
        dueOffsetDays: 1,
        blocking: true,
        ownerRole: 'safety',
      },
      ...DRIVER_COMMON.filter((i) => i.title !== 'Truck assigned'),
    ],
  },
  {
    name: 'Lease operator',
    position: 'Driver',
    department: 'dispatch',
    driverType: 'lease_operator',
    isDefault: false,
    items: [
      W9,
      {
        title: 'Lease agreement signed',
        category: 'paperwork',
        dueOffsetDays: 0,
        blocking: true,
        ownerRole: 'recruiter',
      },
      ...DRIVER_COMMON,
    ],
  },
];

// --------------------------------------------------------------------------------------- gate

export interface OnboardingGate {
  checklistId: string;
  /** Blocking items not yet completed or skipped. */
  blockingOpen: number;
  blockingTitles: string[];
}

/** What still holds the driver at Hired. Skipped counts as resolved; blocked or pending does not. */
export function onboardingGate(
  checklistId: string,
  items: readonly { title: string; blocking: boolean; status: string }[],
): OnboardingGate {
  const open = items.filter(
    (i) => i.blocking && i.status !== 'completed' && i.status !== 'skipped',
  );
  return { checklistId, blockingOpen: open.length, blockingTitles: open.map((i) => i.title) };
}
