import { z } from 'zod';

/**
 * Signing in.
 *
 * One password per user, one session per sign-in. The password itself never leaves the browser
 * except on the way in, and no endpoint in this module ever returns it, a hash of it, or a hint
 * about it — a wrong email and a wrong password fail identically on purpose.
 */

/** What a password has to be. Long beats clever, so the only rule is length. */
export const PASSWORD_MIN_LENGTH = 10;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, `Use at least ${PASSWORD_MIN_LENGTH} characters`)
  .max(200, 'That password is too long');

/**
 * What the person types into the first box.
 *
 * Usually an email address, but an account may be created with a plain name — the built-in
 * `admin` login is the case that matters — so this is an identifier matched against the address on
 * the account, not a validated email. The field keeps its name so nothing downstream changes.
 */
export const LoginRequestSchema = z.object({
  email: z.string().trim().min(1, 'Enter your email address or username'),
  password: z.string().min(1, 'Enter the password'),
  /**
   * Which client is signing in (0081). `mobile` gets a 30-day session (the phone keeps the token in
   * secure storage and revokes it on logout); absent or `web` keeps the 12-hour browser session.
   */
  client: z.enum(['web', 'mobile']).optional(),
});
export type LoginRequest = z.infer<typeof LoginRequestSchema>;
export type LoginClient = 'web' | 'mobile';

export const SetPasswordRequestSchema = z.object({
  password: passwordSchema,
});
export type SetPasswordRequest = z.infer<typeof SetPasswordRequestSchema>;

export const ChangePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1, 'Enter the current password'),
  newPassword: passwordSchema,
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequestSchema>;

/** Light / Dark / System — each worker's own choice, kept on their profile (design/porcelain/SPEC.md §9). */
export const APPEARANCES = ['light', 'dark', 'system'] as const;
export const AppearanceSchema = z.enum(APPEARANCES);
export type Appearance = z.infer<typeof AppearanceSchema>;

export const UpdatePreferencesRequestSchema = z.object({
  appearance: AppearanceSchema,
});
export type UpdatePreferencesRequest = z.infer<typeof UpdatePreferencesRequestSchema>;

/** Who is signed in. The token is returned once, at sign-in, and never read back. */
export interface AuthAccount {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  companyId: string;
  roles: string[];
  permissions: string[];
  isOwner: boolean;
  /** The credential is temporary: nothing else in the product opens until it is replaced. */
  mustChangePassword: boolean;
  /**
   * The person has not filled in their own employee information yet (owner, 2026-10-26). Nothing
   * else opens until they do: the API refuses every other route and the client holds them on
   * Complete your profile. Absent from older servers, which means false.
   */
  profileRequired?: boolean;
  /** The worker's Light / Dark / System choice; `system` until they pick one. */
  appearance: Appearance;
  /** May open the Companies page and create customer companies (grand admin). */
  isPlatformAdmin: boolean;
  /** The company this session works in. */
  companyName?: string;
  /**
   * Every company this person may work in (owner, 2026-10-13: one login across companies); the
   * top bar switches between them.
   */
  companies?: Array<{ companyId: string; companyName: string }>;
  /**
   * Which app shell this membership opens (0081): `driver` when the membership is linked to a
   * roster driver (the driver app), `office` otherwise. Absent from older servers = office.
   */
  kind?: 'driver' | 'office';
  /** The roster driver a driver membership signs in as; null for office accounts. */
  driverId?: string | null;
}

export const SwitchCompanyRequestSchema = z.object({ companyId: z.string().min(1) });
export type SwitchCompanyRequest = z.infer<typeof SwitchCompanyRequestSchema>;

export interface LoginResponse {
  token: string;
  expiresAt: string;
  account: AuthAccount;
}

/**
 * Changing a temporary password.
 *
 * Separate from `ChangePasswordRequest` because the person is already holding a session at this
 * point — they proved the temporary password to get it — and asking for it a second time only
 * invites them to paste it into the new-password field.
 */
export const ReplaceTemporaryPasswordRequestSchema = z
  .object({
    newPassword: passwordSchema,
    confirmPassword: z.string().min(1, 'Repeat the new password'),
  })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ['confirmPassword'],
    message: 'The two passwords do not match',
  });
export type ReplaceTemporaryPasswordRequest = z.infer<typeof ReplaceTemporaryPasswordRequestSchema>;

/**
 * A credential handed to an administrator exactly once.
 *
 * Returned only by the call that creates it, never by a GET: the database keeps a hash, so after
 * this response nothing in the system can tell anyone what the password was.
 */
export interface TemporaryCredential {
  email: string;
  temporaryPassword: string;
}

/** How long a session lasts before the person signs in again. */
export const SESSION_TTL_HOURS = 12;

/** How long a mobile session lasts (`client: 'mobile'` at sign-in, 0081). */
export const MOBILE_SESSION_TTL_DAYS = 30;
