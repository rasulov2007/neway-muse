import { env } from '../../config/env';

/**
 * Server-side feature flags.
 *
 * The browser has had `fleet_v2` since the Fleet work started (`apps/web/src/lib/feature-flags.ts`),
 * but a flag that only hides a page hides nothing: the endpoints behind it answer a direct request
 * just as well. So the flag exists on both sides, and the server's copy is the one that decides
 * whether the feature is reachable at all.
 *
 * Read from the environment once, exactly like the web build reads it once: a flag a running
 * process can be talked into changing is a flag nobody can reason about after an incident.
 */
export type ServerFeatureFlag = 'fleet_v2' | 'pm_module' | 'safety_v2' | 'accidents_v2';

/** Overrides set by tests, so a test can state which world it is testing. */
const overrides = new Map<ServerFeatureFlag, boolean>();

function fromEnv(flag: ServerFeatureFlag): boolean {
  if (flag === 'fleet_v2') return env.FLEET_V2;
  if (flag === 'pm_module') return env.PM_MODULE;
  if (flag === 'safety_v2') return env.SAFETY_V2;
  if (flag === 'accidents_v2') return env.ACCIDENTS_V2;
  return false;
}

/** Is this flag on for this process? */
export function isFeatureEnabled(flag: ServerFeatureFlag): boolean {
  return overrides.get(flag) ?? fromEnv(flag);
}

/** Turn a flag on or off for one test; `null` hands it back to the environment. */
export function setFeatureFlagForTests(flag: ServerFeatureFlag, on: boolean | null): void {
  if (on === null) overrides.delete(flag);
  else overrides.set(flag, on);
}
