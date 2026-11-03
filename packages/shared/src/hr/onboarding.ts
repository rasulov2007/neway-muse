import { z } from 'zod';
import { EMPLOYEE_DEPARTMENTS, EMPLOYMENT_TYPES } from '../people/employee.js';

/**
 * Onboarding: what has to happen before somebody can actually do the job.
 *
 * A checklist belongs to an employee, and progress is *derived* from its items rather than stored.
 * A stored percentage is a number that drifts the first time an item is reopened, and then nobody
 * can tell whether 80% means eight of ten done or eight of ten done a month ago.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const ONBOARDING_STATUSES = [
  'not_started',
  'in_progress',
  'blocked',
  'completed',
  'cancelled',
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const ONBOARDING_ITEM_STATUSES = [
  'pending',
  'in_progress',
  'completed',
  'blocked',
  'skipped',
] as const;
export type OnboardingItemStatus = (typeof ONBOARDING_ITEM_STATUSES)[number];

/** Item statuses that stop the plan from being finished. */
export const OPEN_ONBOARDING_ITEM_STATUSES: readonly OnboardingItemStatus[] = [
  'pending',
  'in_progress',
  'blocked',
];

export const ONBOARDING_CATEGORIES = [
  'paperwork',
  'compliance',
  'systems',
  'equipment',
  'training',
  'orientation',
  'payroll',
] as const;
export type OnboardingCategory = (typeof ONBOARDING_CATEGORIES)[number];

export const OnboardingItemSchema = z.object({
  id: z.string(),
  checklistId: z.string(),
  title: z.string(),
  category: z.enum(ONBOARDING_CATEGORIES),
  ownerEmployeeId: z.string().nullable(),
  ownerName: z.string().nullable(),
  dueDate: isoDate.nullable(),
  status: z.enum(ONBOARDING_ITEM_STATUSES),
  completedByName: z.string().nullable(),
  completedAt: z.string().nullable(),
  sortOrder: z.number().int(),
  notes: z.string().nullable(),
  /** Holds a hired driver at Hired until done. */
  blocking: z.boolean(),
  ownerRole: z.string().nullable(),
  /** Completed from the qualification file when this requirement is verified; never by hand. */
  requirementCode: z.string().nullable(),
});
export type OnboardingItemRecord = z.infer<typeof OnboardingItemSchema>;

export const OnboardingChecklistSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  employeeName: z.string(),
  employeeNumber: z.string(),
  position: z.string(),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  templateId: z.string().nullable(),
  templateName: z.string().nullable(),
  ownerEmployeeId: z.string().nullable(),
  ownerName: z.string().nullable(),
  startDate: isoDate,
  dueDate: isoDate.nullable(),
  status: z.enum(ONBOARDING_STATUSES),
  completedAt: z.string().nullable(),
  notes: z.string().nullable(),
  /** Counted from the items themselves, never stored. */
  totalItems: z.number().int(),
  completedItems: z.number().int(),
  blockedItems: z.number().int(),
  overdueItems: z.number().int(),
  /**
   * The driver this plan is for, when it is a driver's.
   *
   * An office hire has none, and the document counts below are then zero: the state of an office
   * onboarding turns on its tasks alone.
   */
  driverId: z.string().nullable(),
  /** Required documents, counted by where each has got to. Derived, never stored. */
  documentsMissing: z.number().int(),
  documentsPending: z.number().int(),
  documentsRejected: z.number().int(),
  documentsVerified: z.number().int(),
  /** True when the person is already cleared to work. */
  isAvailable: z.boolean(),
  createdAt: z.string(),
});
export type OnboardingChecklistRecord = z.infer<typeof OnboardingChecklistSchema>;

/**
 * Progress as a whole number.
 *
 * Skipped items count as resolved but not as done, so a plan where half the items were skipped does
 * not read as complete. A plan with no items has no progress to report — `null`, not `0`, because
 * "nothing to do" and "nothing done" are different situations.
 */
export function onboardingProgress(completed: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((completed / total) * 100);
}

export const CreateOnboardingChecklistSchema = z.object({
  employeeId: z.string().min(1, 'An employee is required'),
  templateId: z.string().nullable().default(null),
  ownerEmployeeId: z.string().nullable().default(null),
  startDate: isoDate,
  dueDate: isoDate.nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type CreateOnboardingChecklistRequest = z.infer<typeof CreateOnboardingChecklistSchema>;

export const AddOnboardingItemSchema = z.object({
  title: z.string().trim().min(1, 'A title is required').max(120),
  category: z.enum(ONBOARDING_CATEGORIES),
  ownerEmployeeId: z.string().nullable().default(null),
  dueDate: isoDate.nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type AddOnboardingItemRequest = z.infer<typeof AddOnboardingItemSchema>;

export const UpdateOnboardingItemSchema = z.object({
  status: z.enum(ONBOARDING_ITEM_STATUSES).optional(),
  ownerEmployeeId: z.string().nullable().optional(),
  dueDate: isoDate.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateOnboardingItemRequest = z.infer<typeof UpdateOnboardingItemSchema>;

export const OnboardingQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  status: z.enum(ONBOARDING_STATUSES).optional(),
  department: z.enum(EMPLOYEE_DEPARTMENTS).optional(),
  ownerEmployeeId: z.string().max(40).optional(),
  // Newest first by default: with a few hundred plans on file, a case opened this morning was
  // buried among everyone who shares its start date.
  sort: z
    .enum(['createdAt', 'startDate', 'dueDate', 'employeeName', 'status'])
    .default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
  includeFinished: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform((v) => v === true || v === 'true')
    .default(false),
});
export type OnboardingQuery = z.infer<typeof OnboardingQuerySchema>;

export interface OnboardingSummary {
  active: number;
  startingSoon: number;
  overdue: number;
  blocked: number;
  completed: number;
}

/**
 * The default plan.
 *
 * Deliberately role-aware: an office hire is not asked to complete a road test and a driver is not
 * asked to set up a dispatch console. Handing somebody a checklist full of items that do not apply
 * to them is how checklists stop being read.
 */
export interface TemplateItemSeed {
  title: string;
  category: OnboardingCategory;
  dueOffsetDays: number;
  blocking?: boolean;
  ownerRole?: string | null;
  requirementCode?: string | null;
}

const SHARED_ITEMS: TemplateItemSeed[] = [
  { title: 'Signed employment agreement', category: 'paperwork', dueOffsetDays: 0 },
  { title: 'Tax forms (W-4 / state)', category: 'paperwork', dueOffsetDays: 2 },
  { title: 'Work authorization verified (I-9)', category: 'compliance', dueOffsetDays: 3 },
  { title: 'Employee handbook acknowledged', category: 'paperwork', dueOffsetDays: 5 },
  { title: 'Payroll and direct deposit set up', category: 'payroll', dueOffsetDays: 5 },
  { title: 'Company orientation', category: 'orientation', dueOffsetDays: 7 },
];

const DRIVER_ITEMS: TemplateItemSeed[] = [
  { title: 'CDL verified and on file', category: 'compliance', dueOffsetDays: 0 },
  { title: 'Medical certificate on file', category: 'compliance', dueOffsetDays: 0 },
  { title: 'MVR pulled and reviewed', category: 'compliance', dueOffsetDays: 2 },
  { title: 'PSP report reviewed', category: 'compliance', dueOffsetDays: 2 },
  { title: 'Drug and alcohol clearinghouse query', category: 'compliance', dueOffsetDays: 3 },
  { title: 'Pre-employment drug test', category: 'compliance', dueOffsetDays: 3 },
  { title: 'Road test completed', category: 'training', dueOffsetDays: 5 },
  { title: 'ELD and mobile app set up', category: 'systems', dueOffsetDays: 5 },
  { title: 'Truck and equipment assigned', category: 'equipment', dueOffsetDays: 7 },
  { title: 'Safety and defensive driving training', category: 'training', dueOffsetDays: 14 },
];

const STAFF_ITEMS: TemplateItemSeed[] = [
  { title: 'Email account created', category: 'systems', dueOffsetDays: 0 },
  { title: 'TMS access granted', category: 'systems', dueOffsetDays: 1 },
  { title: 'Workstation and phone issued', category: 'equipment', dueOffsetDays: 1 },
  { title: 'Role-specific system training', category: 'training', dueOffsetDays: 10 },
];

/** The items a hire in this position and department should actually get. */
export function defaultOnboardingItems(input: {
  position: string;
  department: string;
}): TemplateItemSeed[] {
  const drives = /driver/i.test(input.position);
  return [...SHARED_ITEMS, ...(drives ? DRIVER_ITEMS : STAFF_ITEMS)].map((item, index) => ({
    ...item,
    sortOrder: index,
  }));
}

export const ONBOARDING_TEMPLATE_MATCHERS = {
  EMPLOYEE_DEPARTMENTS,
  EMPLOYMENT_TYPES,
} as const;
