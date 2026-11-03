import { z } from 'zod';

/**
 * Giving a driver the app (office side, `drivers.edit`): POST /drivers/:idOrNumber/app-access.
 *
 * Creates (or reuses) the person's login and a membership in this company linked to the roster
 * driver with the system role `driver`. The temporary password is in this one response and never
 * again: the database keeps only a hash, and the driver replaces it at first sign-in.
 */

export const GiveAppAccessSchema = z.object({
  /**
   * What the driver types to sign in. An email address, or the phone number (digits only), which
   * becomes the login name `<digits>@phone.neway` - the existing short-name sign-in then accepts
   * the digits alone. Defaults to the driver's email on file, else their phone.
   */
  login: z.string().trim().min(3).max(200).optional(),
});
export type GiveAppAccessRequest = z.input<typeof GiveAppAccessSchema>;

export const RevokeAppAccessSchema = z.object({
  reason: z.string().trim().min(3, 'Say why access is removed').max(500),
});
export type RevokeAppAccessRequest = z.input<typeof RevokeAppAccessSchema>;

export interface DriverAppAccess {
  driverId: string;
  /** none · active · invited · revoked */
  state: 'none' | 'active' | 'invited' | 'revoked';
  membershipId: string | null;
  /** What the driver types to sign in. */
  login: string | null;
  /** The short form the sign-in screen also accepts (the phone digits), when there is one. */
  loginHint: string | null;
  lastSignInAt: string | null;
  mustChangePassword: boolean;
  revokedAt: string | null;
  devices: number;
}

export interface GiveAppAccessResponse {
  access: DriverAppAccess;
  /** Shown once. Null when the person already had a login (they keep their own password). */
  temporaryPassword: string | null;
}

/** The domain a phone-number login is filed under (never emailed). */
export const PHONE_LOGIN_DOMAIN = 'phone.neway';

/** `+1 (555) 123-4567` → `5551234567@phone.neway`; null when there are fewer than 7 digits. */
export function phoneLogin(phone: string): string | null {
  let digits = phone.replace(/\D+/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  return digits.length >= 7 ? `${digits}@${PHONE_LOGIN_DOMAIN}` : null;
}
