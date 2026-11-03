import { Link } from '@tanstack/react-router';
import type { PtiUnitIssues } from '@neway/shared';
import { Badge, StatusSymbol, cn, type BadgeSize } from '@/design-system';
import { isEnabled } from '@/lib/feature-flags';
import { usePtiUnitIssues } from './api';

/** "PTI issue", or "2 PTI issues". */
export function ptiIssueWord(count: number): string {
  return count > 1 ? `${count} PTI issues` : 'PTI issue';
}

/** The tooltip: the word, then one line per defect, worst first. */
export function ptiIssueTitle(issues: PtiUnitIssues): string {
  const head =
    issues.worst === 'oos' ? `${ptiIssueWord(issues.open)} · out-of-service risk` : ptiIssueWord(issues.open);
  return `${head}\n${issues.summary}`;
}

/**
 * The sign beside a unit's status when the walk-around found something not yet fixed (owner,
 * 2026-10-21: an "Available" truck must not hide a PTI problem from dispatch). Symbol, word and
 * colour: the octagon in the urgent family for an out-of-service risk or a replace-now defect, the
 * diamond in the warning family for anything milder.
 */
export function PtiIssueBadge({
  issues,
  size = 'md',
  className,
}: {
  issues: PtiUnitIssues;
  size?: BadgeSize;
  className?: string;
}) {
  const urgent = issues.worst !== 'warning';
  return (
    <Badge
      dot
      size={size}
      tone={urgent ? 'danger' : 'warning'}
      title={ptiIssueTitle(issues)}
      data-pti-issue={issues.worst}
      className={className}
    >
      {ptiIssueWord(issues.open)}
    </Badge>
  );
}

/**
 * The sign for a dense sheet cell, found by unit number (the dispatch board's truck column): the
 * same symbol and colour, with the short word "PTI". The tooltip carries the count and defects.
 */
export function PtiIssueMark({ issues, className }: { issues: PtiUnitIssues; className?: string }) {
  const urgent = issues.worst !== 'warning';
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 text-2xs font-semibold',
        urgent ? 'text-nw-urgent-text' : 'text-nw-warning-text',
        className,
      )}
      title={ptiIssueTitle(issues)}
      data-pti-issue={issues.worst}
    >
      <StatusSymbol
        family={urgent ? 'urgent' : 'warning'}
        size={11}
        className={urgent ? 'text-nw-urgent-icon' : 'text-nw-warning-icon'}
      />
      <span>PTI</span>
      <span className="sr-only">{`: ${ptiIssueWord(issues.open)}`}</span>
    </span>
  );
}

/** The board's mark for a typed truck number; nothing until the answer arrives or with no issue. */
export function BoardPtiIssueMark({ unitNumber }: { unitNumber: string | null | undefined }) {
  const query = usePtiUnitIssues(isEnabled('fleet_v2'));
  const wanted = unitNumber?.trim().toLowerCase();
  if (!wanted || !query.data) return null;
  const issues = Object.values(query.data).find(
    (entry) => entry.unitNumber?.trim().toLowerCase() === wanted,
  );
  return issues ? <PtiIssueMark issues={issues} className="ml-1" /> : null;
}

/**
 * A trailer's sign. Trailer work belongs to the trailer, so a defect recorded on it shows here and
 * not on the truck pulling it. The trailer page has no defects list to open, so the tooltip is the
 * detail.
 */
export function TrailerPtiIssueBadge({ trailerId }: { trailerId: string }) {
  const query = usePtiUnitIssues(isEnabled('fleet_v2'));
  const issues = query.data?.[trailerId];
  return issues ? <PtiIssueBadge issues={issues} /> : null;
}

/**
 * A truck's sign, read from the shared `unit-issues` query, linking to the unit's Maintenance tab
 * where its open defects are listed. Draws nothing until the answer has arrived, and nothing when
 * the truck has no issue or `fleet_v2` is off.
 */
export function TruckPtiIssueBadge({
  truckId,
  size = 'md',
  className,
}: {
  truckId: string;
  size?: BadgeSize;
  className?: string;
}) {
  const query = usePtiUnitIssues(isEnabled('fleet_v2'));
  const issues = query.data?.[truckId];
  if (!issues) return null;
  return (
    <Link
      to="/fleet/trucks/$truckId"
      params={{ truckId }}
      search={{ tab: 'maintenance' }}
      aria-label={`${ptiIssueTitle(issues)}. Open the unit's defects`}
      className={cn(
        'inline-flex shrink-0 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        className,
      )}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
    >
      <PtiIssueBadge issues={issues} size={size} className="cursor-pointer" />
    </Link>
  );
}
