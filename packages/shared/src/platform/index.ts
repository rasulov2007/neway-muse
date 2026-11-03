import { z } from 'zod';

/**
 * The Companies page: the platform administrator's control plane (owner, 2026-10-01).
 *
 * A platform administrator ("grand admin") creates customer companies and their first
 * administrator, renames them, issues that administrator a new temporary password, and deactivates
 * or reactivates a company. Nothing here reads a company's own work - loads, drivers, money - and
 * nothing is ever deleted: a deactivated company is hidden, kept and reversible.
 *
 * Every write carries the `version` (the company's `updatedAt`) the screen last saw; a stale one is
 * refused with 409 rather than overwriting someone else's change.
 */

export interface PlatformCompany {
  id: string;
  name: string;
  timezone: string;
  /** active · deactivated */
  status: 'active' | 'deactivated';
  deactivatedAt: string | null;
  deactivatedReason: string | null;
  /** Accounts with an active or invited membership. */
  userCount: number;
  /** The company's owner administrator, when it has one. */
  admin: { membershipId: string; name: string; email: string; lastLoginAt: string | null } | null;
  createdAt: string;
  /** Pass back on every write; the company's `updatedAt`. */
  version: string;
}

const companyName = z.string().trim().min(2, 'At least 2 characters').max(120);

export const CreatePlatformCompanySchema = z.object({
  name: companyName,
  adminEmail: z.string().trim().toLowerCase().email('Enter a valid email address'),
  adminFirstName: z.string().trim().min(1, 'Required').max(80),
  adminLastName: z.string().trim().max(80).default('Admin'),
});
export type CreatePlatformCompany = z.infer<typeof CreatePlatformCompanySchema>;

export const RenamePlatformCompanySchema = z.object({
  name: companyName,
  version: z.string().min(1),
});
export type RenamePlatformCompany = z.infer<typeof RenamePlatformCompanySchema>;

export const PlatformCompanyVersionSchema = z.object({ version: z.string().min(1) });
export type PlatformCompanyVersion = z.infer<typeof PlatformCompanyVersionSchema>;

export const DeactivatePlatformCompanySchema = z.object({
  version: z.string().min(1),
  reason: z.string().trim().min(3, 'Say why (at least 3 characters)').max(500),
});
export type DeactivatePlatformCompany = z.infer<typeof DeactivatePlatformCompanySchema>;

/** Creating a company or reissuing its administrator's password; the password is shown once. */
export interface PlatformCredential {
  company: PlatformCompany;
  email: string;
  temporaryPassword: string;
}
