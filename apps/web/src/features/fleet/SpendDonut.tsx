import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import {
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Sector,
  type PieSectorShapeProps,
} from 'recharts';
import {
  animationDurationSlow,
  chartTheme,
  cn,
  seriesColor,
  useChartAnimation,
} from '@/design-system';
import { formatMoney } from '@/lib/format';

export interface SpendSlice {
  label: string;
  spend: number;
  sharePct: number;
  /**
   * The category's own id, as the engine groups by it. A link is built from this, never from the
   * label - two categories can read alike and a page filtered by words is a page that shows the
   * wrong records.
   */
  key?: string;
}

/** Rounded slice ends with a small gap; the hovered or chosen slice steps out a little. */
function Slice(props: PieSectorShapeProps & { lifted?: boolean }) {
  const lift = props.isActive || props.lifted ? chartTheme.activeSliceOffset + 3 : 0;
  return (
    <Sector
      cx={props.cx}
      cy={props.cy}
      innerRadius={props.innerRadius}
      outerRadius={props.outerRadius + lift}
      startAngle={props.startAngle}
      endAngle={props.endAngle}
      cornerRadius={6}
      fill={props.fill}
      stroke={chartTheme.surface}
      strokeWidth={2}
      tabIndex={props.tabIndex}
      data-recharts-item-index={props['data-recharts-item-index']}
      data-recharts-item-id={props['data-recharts-item-id']}
      style={{ transition: 'all 220ms ease-out', cursor: 'pointer' }}
    />
  );
}

/**
 * Spend by category as the owner wants it to look (2026-09-22): a thick ring with rounded slice
 * ends and small gaps, sweeping in on load; the total in the centre; a legend where each row
 * carries the share bold and the amount beneath, and hovering a row lifts its slice. Colours
 * are the categorical series order; the numbers are the server's.
 */
export function SpendDonut({
  slices,
  total,
  hrefFor,
}: {
  slices: SpendSlice[];
  total: number;
  /** Where a category leads. Left out, the ring is a picture and nothing is clickable. */
  hrefFor?: (slice: SpendSlice) => { to: string; params: Record<string, string>; search: Record<string, unknown> } | null;
}) {
  const navigate = useNavigate();
  const animation = useChartAnimation(true, animationDurationSlow);
  const [active, setActive] = useState<number | null>(null);
  const colors = slices.map((_, i) => seriesColor(i));
  const shown = active === null ? null : slices[active];

  return (
    <div className="flex h-full min-h-[260px] flex-col items-center gap-4 sm:flex-row sm:gap-8">
      <div className="relative size-[230px] shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart className="chart-plot" margin={{ top: 6, right: 6, bottom: 6, left: 6 }}>
            <Pie
              data={slices}
              dataKey="spend"
              nameKey="label"
              innerRadius="66%"
              outerRadius="92%"
              paddingAngle={slices.length > 1 ? 3 : 0}
              startAngle={90}
              endAngle={-270}
              shape={(p: PieSectorShapeProps) => (
                <Slice {...p} lifted={active !== null && p.index === active} />
              )}
              isAnimationActive={animation.isAnimationActive}
              animationDuration={animation.animationDuration}
              animationEasing={animation.animationEasing}
              animationBegin={0}
              onMouseEnter={(_, i) => setActive(i)}
              onMouseLeave={() => setActive(null)}
              onClick={(_, i) => {
                const target = hrefFor?.(slices[i]!);
                if (target) void navigate(target as never);
              }}
              className={hrefFor ? 'cursor-pointer' : undefined}
            >
              {slices.map((s, i) => (
                <Cell key={s.label} fill={colors[i]} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="text-[10px] font-bold tracking-[.08em] text-nw-text-3 uppercase">
            {shown ? shown.label : 'Total'}
          </span>
          <span className="tabular mt-0.5 text-[22px] leading-none font-bold text-ink">
            {formatMoney(shown ? shown.spend : total, {
              compact: (shown ? shown.spend : total) >= 1_000_000,
            })}
          </span>
          {shown ? (
            <span className="tabular mt-1 text-xs text-nw-text-2">
              {shown.sharePct.toFixed(1)}%
            </span>
          ) : null}
        </div>
      </div>
      <ul aria-label="Legend" className="flex w-full min-w-0 flex-1 flex-col">
        {slices.map((s, i) => {
          const target = hrefFor?.(s) ?? null;
          const Row = target ? Link : 'div';
          return (
          <li key={s.label} onMouseEnter={() => setActive(i)} onMouseLeave={() => setActive(null)}>
          <Row
            {...(target ? (target as never) : {})}
            className={cn(
              'flex items-center gap-3 rounded-md px-2 py-2 transition-colors',
              active === i && 'bg-nw-hover',
              target &&
                'cursor-pointer focus-visible:ring-2 focus-visible:ring-nw-accent focus-visible:outline-none',
            )}
            {...(target ? { 'aria-label': `${s.label}: see the records behind this amount` } : {})}
          >
            <span
              aria-hidden
              className="size-2.5 shrink-0 rounded-full"
              style={{ background: colors[i] }}
            />
            <span className="min-w-0 flex-1 truncate text-[13px] text-nw-text">{s.label}</span>
            <span className="text-right">
              <span className="tabular block text-sm font-bold text-ink">
                {s.sharePct.toFixed(1)}%
              </span>
              <span className="tabular block text-[11px] text-nw-text-3">
                {formatMoney(s.spend, { compact: s.spend >= 100_000 })}
              </span>
            </span>
            {target ? <ChevronRight aria-hidden className="size-4 shrink-0 text-nw-text-3" /> : null}
          </Row>
          </li>
          );
        })}
      </ul>
    </div>
  );
}
