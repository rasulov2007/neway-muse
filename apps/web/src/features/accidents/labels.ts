import { safetyRules as R } from '@neway/shared';

/** A five-state answer as words; null = not reported yet (SPEC §7.1). */
export function triText(t: R.Tri): string {
  return t === null ? 'Not reported yet' : R.triLabel(t);
}

/** A fresh Idempotency-Key for one report (a retry with the same key returns the first result). */
export function newIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
}

/** Tone of a claim status (symbol + word + colour via ToneBadge). */
export function claimStatusTone(st: R.ClaimStatus): string {
  return st === 'Settled' || st === 'Closed' ? 'done' : st === 'Denied' ? 'neutral' : st === 'Awaiting documents' || st === 'Draft' ? 'warning' : 'moving';
}

/** A v2 case as a row of a unit's History timeline (TruckHistoryTab). */
export function stageStatus(stage: R.Stage): string {
  return stage === 'closed' ? 'closed' : stage === 'investigation' ? 'investigating' : stage === 'draft' ? 'draft' : stage === 'resolution' ? 'open' : 'reported';
}
