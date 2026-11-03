import { SetMetadata } from '@nestjs/common';

export const SIGNED_IN_ONLY_KEY = 'auth:signedInOnly';

/**
 * An explicit, reviewed "any signed-in member of the company" policy (owner brief, 2026-10-25).
 *
 * Deny by default means a route with no declared policy is refused. A route that genuinely belongs
 * to everybody who is signed in - your own profile, your own notifications, a picker every page
 * needs - says so here, with the reason, so the decision is written down and shows up in the
 * permission matrix instead of being an accident of a missing decorator.
 *
 * The reason must name what narrows the route further, if anything (the caller's own rows, a
 * service-level permission check, a guard). An empty reason is refused at boot.
 */
export const SignedInOnly = (reason: string): MethodDecorator & ClassDecorator =>
  SetMetadata(SIGNED_IN_ONLY_KEY, reason);
