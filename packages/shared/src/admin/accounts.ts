import { z } from 'zod';

/**
 * Accounts: the contract between the administration UI and the control plane.
 *
 * Three records describe a person and none replaces another (the split `people/employee.ts`
 * already commits to):
 *
 *   User        an identity that can sign in. Global — no company on it.
 *   Membership  that user's access to one company, with a status and a set of roles.
 *   Employee    the workforce record. Optional in both directions.
 *
 * Everything the administration screens call "a user" is a **membership**, because access is what
 * an administrator manages and access only exists inside a company. The API therefore addresses
 * accounts by `membershipId`, never by `userId`: a user id would be ambiguous the moment the same
 * person works for two carriers.
 */

export const ACCOUNT_STATUSES = ['invited', 'active', 'suspended', 'disabled', 'archived'] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  invited: 'Invited',
  active: 'Active',
  suspended: 'Suspended',
  disabled: 'Disabled',
  archived: 'Archived',
};

/**
 * What each status means operationally. Shown in the UI because "suspended" and "disabled" are
 * indistinguishable from a badge alone, and an administrator choosing between them is deciding
 * whether the person is coming back.
 */
export const ACCOUNT_STATUS_MEANING: Record<AccountStatus, string> = {
  invited: 'Invitation recorded. Cannot sign in until it is accepted.',
  active: 'Can sign in and use everything their roles allow.',
  suspended: 'Temporarily blocked. Roles and history are kept.',
  disabled: 'Access ended. Kept for the audit trail; never deleted.',
  archived: 'Not needed. Hidden from the list, cannot sign in, kept for the audit trail and can be restored.',
};

/** Statuses an account can be moved to by an administrator. Acceptance is not one of them. */
export const ASSIGNABLE_ACCOUNT_STATUSES: readonly AccountStatus[] = [
  'active',
  'suspended',
  'disabled',
  'archived',
];

export const AccountRoleSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
});

export const AdminAccountSchema = z.object({
  membershipId: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  phone: z.string().nullable(),
  status: z.enum(ACCOUNT_STATUSES),
  /** The one account that cannot be disabled or stripped of administration. */
  isOwner: z.boolean(),
  mfaEnabled: z.boolean(),
  /** Whether a password exists on the account, so the Users screen can say who can sign in. */
  hasPassword: z.boolean().default(false),
  employeeId: z.string().nullable(),
  employeeName: z.string().nullable(),
  employeeNumber: z.string().nullable(),
  department: z.string().nullable(),
  roles: z.array(AccountRoleSchema),
  /**
   * Complete your profile (2026-10-26): `pending` while the person still has to fill in their own
   * employee information, `complete` once they have (or a record is linked), `exempt` for
   * administrators and the owner, and for everybody while the company setting is off.
   */
  profileStatus: z.enum(['complete', 'pending', 'exempt']).optional(),
  profileCompletedAt: z.string().nullable().optional(),
  invitedAt: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});
export type AdminAccount = z.infer<typeof AdminAccountSchema>;

export const CreateAccountSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(80),
  lastName: z.string().trim().min(1, 'Last name is required').max(80),
  email: z.string().trim().toLowerCase().email('Enter a valid email address'),
  phone: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .transform((v) => v || null),
  /** Link to a workforce record now, or leave it for later. Both are ordinary. */
  employeeId: z
    .string()
    .nullish()
    .transform((v) => v || null),
  /**
   * At least one. An account with no role signs in and is refused by every screen it opens, which
   * is indistinguishable from the product being broken - and is exactly what people reported.
   */
  roleIds: z
    .array(z.string())
    .min(1, 'Pick at least one role, or the person will not be able to use anything'),
  /**
   * Records that an invitation was issued. It does **not** send an email: this deployment has no
   * mail transport, and the UI says so rather than implying a message is on its way.
   */
  invite: z.boolean().default(true),
});
export type CreateAccountInput = z.input<typeof CreateAccountSchema>;

export const UpdateAccountSchema = z.object({
  firstName: z.string().trim().min(1).max(80).optional(),
  lastName: z.string().trim().min(1).max(80).optional(),
  phone: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .transform((v) => v || null)
    .optional(),
  employeeId: z
    .string()
    .nullish()
    .transform((v) => v || null)
    .optional(),
});

export const SetAccountStatusSchema = z.object({
  status: z.enum(['active', 'suspended', 'disabled', 'archived']),
  reason: z
    .string()
    .trim()
    .max(500)
    .nullish()
    .transform((v) => v || null),
});

export const SetAccountRolesSchema = z.object({
  roleIds: z.array(z.string()),
});

export const AccountQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().min(1).optional(),
  status: z.enum(ACCOUNT_STATUSES).optional(),
  roleId: z.string().optional(),
  department: z.string().optional(),
  /** `pending`: only the accounts that still have to complete their own profile. */
  profile: z.enum(['pending']).optional(),
});
export type AccountQuery = z.infer<typeof AccountQuerySchema>;

export const AccountSummarySchema = z.object({
  /** Every account that is not archived (owner, 2026-10-22: archived invitations are gone from the count). */
  total: z.number(),
  active: z.number(),
  invited: z.number(),
  suspended: z.number(),
  disabled: z.number(),
  /** Archived accounts, counted on their own and listed only when asked for. */
  archived: z.number(),
});
export type AccountSummary = z.infer<typeof AccountSummarySchema>;

/**
 * Whether an invitation can actually be delivered.
 *
 * There is no mail transport in this deployment. The invitation is a real, dated, expiring record
 * — it is the thing that will let someone set a password once sign-in exists — but nothing leaves
 * the server, and every screen that offers to invite says exactly that. Pretending otherwise would
 * leave an administrator waiting for an email that was never going to arrive.
 */
export const INVITATION_DELIVERY = {
  available: false,
  reason:
    'No mail transport is configured, so no invitation email is sent. The invitation is recorded and can be shared out of band.',
} as const;

/** Links an account to its workforce record, or unlinks it (`null`). One account per employee. */
export const SetAccountEmployeeSchema = z.object({
  employeeId: z.string().min(1).max(80).nullable(),
});
export type SetAccountEmployeeRequest = z.infer<typeof SetAccountEmployeeSchema>;
