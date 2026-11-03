import { StatusBadge } from '@/design-system';
import type { HeaderVerdict } from './unit-verdict';

/**
 * The header's single pill: symbol + word, through the status system. "Loading…" is a word too,
 * on the neutral family, so nothing reads as fit before the server has said so.
 */
export function UnitVerdictBadge({ verdict }: { verdict: HeaderVerdict }) {
  return <StatusBadge status={verdict.status} label={verdict.label} />;
}

/** "hold: DEF-4417 — released when DEF-4417 is verified": the reason and the way out, in one line. */
export function UnitVerdictLine({ verdict }: { verdict: HeaderVerdict }) {
  if (!verdict.reason && !verdict.releaseCondition) return null;
  return (
    <span className="text-sm text-muted">
      {verdict.reason}
      {verdict.reason && verdict.releaseCondition ? ' — ' : ''}
      {verdict.releaseCondition}
    </span>
  );
}
