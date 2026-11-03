/**
 * Feature flags.
 *
 * The Fleet upgrade changes how people enter data, and a change to a form somebody uses every day
 * must not arrive unannounced. So the new entry rules sit behind `fleet_v2`, which is **off in a
 * production build** and on in local development, where the work is reviewed before anyone is
 * asked to live with it.
 *
 * Flags are read from the build, not from the browser: `VITE_FLAGS=fleet_v2,other` at build time.
 * Nothing here reads `localStorage` — a flag a user can set for themselves is a flag nobody can
 * reason about afterwards, and the workspace has already learned that lesson about state.
 */

/** `accidents_v2` (Accident & Claims v2) is NOT in DEV_DEFAULTS: off everywhere until listed in VITE_FLAGS (owner, 2026-10-21). */
export type FeatureFlag = 'fleet_v2' | 'pm_module' | 'safety_v2' | 'claims_v2' | 'accidents_v2';

/** Flags that are on in local development without anybody asking for them. */
const DEV_DEFAULTS: readonly FeatureFlag[] = ['fleet_v2', 'pm_module', 'safety_v2', 'claims_v2'];

function fromEnv(): Set<string> {
  const raw = (import.meta.env.VITE_FLAGS as string | undefined) ?? '';
  const listed = raw
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  // An explicit list always wins, including an explicit empty one via VITE_FLAGS=none.
  if (listed.length > 0) return new Set(listed.includes('none') ? [] : listed);
  return new Set(import.meta.env.DEV ? DEV_DEFAULTS : []);
}

const enabled = fromEnv();

/** Overrides set by tests, so a test can state which world it is testing. */
const overrides = new Map<FeatureFlag, boolean>();

/** Is this flag on? */
export function isEnabled(flag: FeatureFlag): boolean {
  const override = overrides.get(flag);
  return override ?? enabled.has(flag);
}

/** Turn a flag on or off for one test; `null` hands it back to the build. */
export function setFlagForTests(flag: FeatureFlag, on: boolean | null): void {
  if (on === null) overrides.delete(flag);
  else overrides.set(flag, on);
}
