import { SetMetadata } from '@nestjs/common';

export const PUBLIC_ROUTE_KEY = 'neway:public-route';

/**
 * Reachable without a session.
 *
 * The list is deliberately tiny and every member has to be justifiable: signing in, signing out,
 * asking who you are, and the liveness probe. Anything else is behind `AuthenticatedGuard`.
 */
export const Public = () => SetMetadata(PUBLIC_ROUTE_KEY, true);

export const TEMPORARY_PASSWORD_ROUTE_KEY = 'neway:temporary-password-route';

/**
 * Reachable while the caller's password is still the temporary one.
 *
 * Only the route that replaces it, so a person holding a temporary credential can finish the
 * handover and nothing more.
 */
export const AllowTemporaryPassword = () => SetMetadata(TEMPORARY_PASSWORD_ROUTE_KEY, true);

export const BEFORE_PROFILE_ROUTE_KEY = 'neway:before-profile-route';

/**
 * Reachable while the caller still has to complete their own profile (owner, 2026-10-26): the
 * profile endpoints themselves, signing out and changing a password. `GET /auth/me` is public.
 * Everything else is refused until the profile is submitted.
 */
export const AllowBeforeProfile = () => SetMetadata(BEFORE_PROFILE_ROUTE_KEY, true);
