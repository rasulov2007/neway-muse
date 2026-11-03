import type { DispatchOverrideResult, UnitServiceVerdict } from '@neway/shared';
import { apiGet, apiPost } from '@/lib/api-client';
import { isEnabled } from '@/lib/feature-flags';

/**
 * The hold at the point of dispatch (§9.1).
 *
 * A unit with an open out-of-service defect cannot be put on a load. The verdict is the server's
 * (`GET /fleet/pti/units/:id/status`), asked at the moment of the write and never cached, so a
 * defect raised a minute ago holds the truck now. The way past it is a named, reasoned override
 * that the server writes on the defect and in the audit trail before the load is touched; a
 * refusal leaves the load as it was.
 *
 * Behind `fleet_v2` with the routes it reads: with the flag off the guard is silent, as it was.
 */
export class DispatchBlockedError extends Error {
  readonly unitId: string;
  readonly unitNumber: string;
  readonly verdict: UnitServiceVerdict;

  constructor(unit: { id: string; unitNumber: string }, verdict: UnitServiceVerdict) {
    super(
      `Unit ${unit.unitNumber} is out of service — ${verdict.reason ?? 'an open defect holds it'}. ${verdict.releaseCondition ?? ''}`.trim(),
    );
    this.name = 'DispatchBlockedError';
    this.unitId = unit.id;
    this.unitNumber = unit.unitNumber;
    this.verdict = verdict;
  }
}

export function isDispatchBlocked(error: unknown): error is DispatchBlockedError {
  return error instanceof DispatchBlockedError;
}

export interface DispatchOverride {
  reason: string;
}

/**
 * Throws `DispatchBlockedError` when the unit is held and no override was given; with one, logs
 * it on the server and returns. Resolves silently when the unit is not held.
 */
export async function assertDispatchAllowed(
  unit: { id: string; unitNumber: string },
  load: { ref: string },
  override?: DispatchOverride | null,
): Promise<void> {
  if (!isEnabled('fleet_v2')) return;
  const status = await apiGet<{ verdict: UnitServiceVerdict }>(`/fleet/pti/units/${unit.id}/status`);
  if (!status.verdict.dispatchBlocked) return;
  if (!override?.reason.trim()) throw new DispatchBlockedError(unit, status.verdict);
  await apiPost<DispatchOverrideResult>(`/fleet/pti/units/${unit.id}/dispatch-override`, {
    loadRef: load.ref,
    reason: override.reason.trim(),
  });
}
