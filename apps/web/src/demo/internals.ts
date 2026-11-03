/**
 * Plumbing shared by every demo write module.
 *
 * `api.ts` and `fleet-writes.ts` both need the same latency simulation, the same clone-on-read
 * discipline and the same audit stream. They live here rather than in `api.ts` so that a second
 * write module cannot end up with its own latency switch (which would leave `setDemoLatency(false)`
 * only half-effective in tests) or its own audit numbering.
 */
import { demoCurrentUser, demoData, demoUsers } from './data';
import { pendingHydration } from './state-persist';
import type { ComplianceAuditEntry } from './types';

export type Simulate = 'error' | 'empty' | 'slow';

export interface SimulateOptions {
  simulate?: Simulate;
}

const MIN_LATENCY = 120;
const MAX_LATENCY = 350;
const SLOW_LATENCY = 2500;

/**
 * Fake latency, off by default.
 *
 * This used to be on everywhere, including the deployed build: every read slept 120–350 ms before
 * returning data the browser already had. The operations bundle awaits two tiers of these reads,
 * so a page paid it several times over, and the cost landed squarely on navigation — it was a
 * large part of why going "back" to a list felt broken.
 *
 * It stays available for demonstrating loading states (`setDemoLatency(true)`), and an explicit
 * `simulate: 'slow' | 'error' | 'empty'` on a single call is still honoured, because that is how
 * the empty and error states are exercised. Nothing sleeps unless it was asked to.
 */
let latencyEnabled = false;

export function setDemoLatency(enabled: boolean): void {
  latencyEnabled = enabled;
}

function wait(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fleetRespond<T>(
  options: SimulateOptions | undefined,
  produce: () => T,
  empty: () => T,
): Promise<T> {
  // The workspace first, always: answering from the generated dataset while the real one is on
  // its way is an answer that looks right and is wrong (see `pendingHydration`). Once it has
  // landed there is nothing left to wait for, so a read after boot costs nothing.
  const hydration = pendingHydration();
  if (hydration) await hydration;
  const simulate = options?.simulate;
  // `slow` is an explicit request to be slow and is always honoured; the ambient delay is not.
  const latency =
    simulate === 'slow'
      ? SLOW_LATENCY
      : latencyEnabled
        ? MIN_LATENCY + Math.random() * (MAX_LATENCY - MIN_LATENCY)
        : 0;
  await wait(latency);
  if (simulate === 'error') throw new Error('Simulated failure');
  if (simulate === 'empty') return empty();
  return produce();
}

export function cloneValue<T>(value: T): T {
  return structuredClone(value);
}

export function nowIsoString(): string {
  return new Date().toISOString();
}

export function actorFor(name: string): { actorId: string; actorName: string } {
  const user = demoUsers.find((u) => u.name === name);
  return { actorId: user?.id ?? demoCurrentUser.id, actorName: name };
}

/** Appends to the same audit stream the compliance module writes, with the same id sequence. */
export function appendFleetAudit(
  entry: Omit<ComplianceAuditEntry, 'id' | 'at' | 'actorId' | 'actorName' | 'source'> & {
    by?: string;
    source?: ComplianceAuditEntry['source'];
  },
): ComplianceAuditEntry {
  const { by, source, ...rest } = entry;
  const row: ComplianceAuditEntry = {
    id: `aud_${String(demoData.complianceAudit.length + 1).padStart(4, '0')}`,
    at: nowIsoString(),
    ...actorFor(by ?? demoCurrentUser.name),
    source: source ?? 'user',
    ...rest,
  };
  demoData.complianceAudit.unshift(row);
  return row;
}

/**
 * The largest page any list helper will serve. It guards against a runaway page size, not
 * against the data: a client-side store of a few thousand rows is nothing, and a cap of 200 is
 * how a workspace with 851 brokers once showed a register of 200.
 */
export const MAX_PAGE_SIZE = 10_000;
/** Ask for everything - every list helper caps at MAX_PAGE_SIZE, so this is "no cap". */
export const ALL_ROWS = MAX_PAGE_SIZE;
