import { DEMO_TODAY } from '../reporting/demo/demo-company';

/** Injection token for the clock the dashboard resolves "today" from. */
export const CLOCK = Symbol('CLOCK');

/** Returns the current instant; injected so periods are deterministic in tests and demo mode. */
export type Clock = () => Date;

/** Wall-clock time. */
export const systemClock: Clock = () => new Date();

/**
 * Demo-mode clock: `DEMO_TODAY` at 14:30 America/Chicago (CDT, UTC-5). Pinning it keeps the demo
 * dashboard stable: `this_week` is always Aug 31 – Sep 6, 2026 and the current dispatch week is
 * always the incomplete one. Swap for `systemClock` once a database source exists.
 */
export const demoClock: Clock = () => new Date(`${DEMO_TODAY}T14:30:00-05:00`);
