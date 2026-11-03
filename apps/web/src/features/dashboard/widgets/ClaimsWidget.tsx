import { useNavigate } from '@tanstack/react-router';
import { useMemo } from 'react';
import {
  SafetySummaryStrip,
  type SafetySummarySegment,
} from '@/features/safety/components/SafetyKit';
import { useSafety } from '@/features/safety/useSafety';
import type { Claim } from '@/demo';

/**
 * Where the insurance claims have got to.
 *
 * Four numbers, because four is what anybody asks: how many there are, how many are still live,
 * how many are finished, and how many were denied. A denial is the outcome worth its own number —
 * it is the one that leaves the loss with the carrier.
 *
 * The counts come from the same records the Claims register lists, and each one opens that
 * register rather than restating it here.
 */
const DONE_STATUSES = ['settled', 'closed'];

function groupOf(claim: Claim): 'open' | 'done' | 'denied' {
  if (claim.status === 'denied') return 'denied';
  return DONE_STATUSES.includes(claim.status) ? 'done' : 'open';
}

export function ClaimsWidget() {
  const navigate = useNavigate();
  const safety = useSafety();
  const claims = useMemo(() => safety.data?.claims ?? [], [safety.data]);

  const counts = useMemo(() => {
    const tally = { all: claims.length, open: 0, done: 0, denied: 0 };
    for (const claim of claims) tally[groupOf(claim)] += 1;
    return tally;
  }, [claims]);

  const open = () => void navigate({ to: '/safety/claims' });
  const segments: SafetySummarySegment[] = [
    { key: 'all', label: 'Claims', count: safety.isPending ? null : counts.all, onSelect: open },
    {
      key: 'open',
      label: 'Open',
      count: safety.isPending ? null : counts.open,
      tone: counts.open > 0 ? 'warning' : 'default',
      onSelect: open,
    },
    {
      key: 'done',
      label: 'Settled or closed',
      count: safety.isPending ? null : counts.done,
      tone: 'success',
      onSelect: open,
    },
    {
      key: 'denied',
      label: 'Denied',
      count: safety.isPending ? null : counts.denied,
      tone: counts.denied > 0 ? 'danger' : 'default',
      onSelect: open,
    },
  ];

  return <SafetySummaryStrip segments={segments} loading={safety.isPending} />;
}
