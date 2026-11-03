import type { ReactNode } from 'react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  StatTile,
  cn,
  type StatusTone,
} from '@/design-system';
import { formatNumber } from '@/lib/format';

/**
 * The clickable count strip that leads every Fleet page.
 *
 * A row of `StatTile`s rather than `KpiCard`: a fleet summary is a *filter control* that happens to
 * show counts, not a dashboard metric. Each tile applies the filter it describes — which is also
 * why the counts must come from the same predicate the table filters on. A tile whose count and
 * list are derived separately will eventually disagree.
 */

export type FleetSummaryTone = 'default' | StatusTone | 'primary';

export interface FleetSummarySegment {
  key: string;
  label: string;
  count: number | null;
  /** Colours the icon tile; with `valueTone`, the count as well. */
  tone?: FleetSummaryTone;
  /** Colour the count with `tone` — for the segments that are themselves the problem. */
  valueTone?: boolean;
  /** 16px Lucide icon for the tinted tile. */
  icon?: ReactNode;
  /** Muted line under the count (Available carries the fleet total, owner 2026-10-10). */
  hint?: ReactNode;
  /** Omit to render the segment as a plain, non-clickable total. */
  onSelect?: () => void;
  /**
   * Content to open instead of applying a filter.
   *
   * Used by the findings segment: the exception list used to be a panel above the strip, which
   * made five coloured cards the first thing every fleet page said. Behind a segment it is one
   * number until somebody asks for it.
   */
  popover?: ReactNode;
}

export interface FleetSummaryStripProps {
  segments: FleetSummarySegment[];
  /** Key of the segment currently applied, so the strip shows what the table is showing. */
  activeKey?: string | null;
  loading?: boolean;
  /** Put every icon on the trailing edge of its tile. */
  iconRight?: boolean;
  className?: string;
}

function tileTone(tone: FleetSummaryTone | undefined): StatusTone | 'primary' {
  return tone === undefined || tone === 'default' ? 'primary' : tone;
}

export function FleetSummaryStrip({
  segments,
  activeKey,
  loading,
  iconRight = false,
  className,
}: FleetSummaryStripProps) {
  return (
    <div className={cn('flex flex-wrap gap-3 [&>*]:min-w-36 [&>*]:flex-1', className)}>
      {segments.map((segment) => {
        const active = activeKey != null && activeKey === segment.key;
        const value = loading ? (
          <span className="mt-1 block h-6 w-10 animate-pulse rounded bg-surface-muted" />
        ) : segment.count === null ? (
          '—'
        ) : (
          formatNumber(segment.count)
        );
        const tile = {
          label: segment.label,
          value,
          icon: segment.icon,
          hint: loading ? undefined : segment.hint,
          tone: tileTone(segment.tone),
          valueTone: segment.valueTone,
          iconRight,
        };

        if (segment.popover) {
          // The trigger is the button so Radix gets its ref and state; the tile inside stays a
          // plain tile, which keeps the accessible name "Label count".
          return (
            <Popover key={segment.key}>
              <PopoverTrigger className="flex rounded-lg text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus">
                <StatTile
                  {...tile}
                  className="w-full cursor-pointer transition-colors duration-(--duration-base) hover:border-line hover:bg-surface-hover"
                />
              </PopoverTrigger>
              <PopoverContent align="end" className="w-[min(46rem,90vw)] p-0">
                {segment.popover}
              </PopoverContent>
            </Popover>
          );
        }

        return segment.onSelect ? (
          <StatTile key={segment.key} {...tile} onClick={segment.onSelect} pressed={active} />
        ) : (
          <StatTile key={segment.key} {...tile} />
        );
      })}
    </div>
  );
}
