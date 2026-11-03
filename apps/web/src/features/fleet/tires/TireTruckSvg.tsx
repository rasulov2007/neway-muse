import type { CSSProperties, ReactNode } from 'react';
import { TIRE_POSITIONS, tirePositionLabel, type TirePosition, type TirePositionKey } from '@neway/shared';

/**
 * A top-down American sleeper tractor and a 53-foot dry van, front to the LEFT, passenger side (RH)
 * at the top and driver side (LH) at the bottom - with the 18 tire positions as separate,
 * individually clickable shapes (owner brief, 2026-10-13).
 *
 * Colours are Porcelain tokens only. The drawing sits in a light-theme frame (as documents do) so
 * the tires stay graphite and the van stays white in dark mode too.
 *
 * Geometry lives in `TIRE_GEOMETRY` so a badge or a hit area can be nudged without touching the
 * drawing; the tires, the count badges and the click targets are three separate layers.
 */

export const VIEW_W = 1000;
export const VIEW_H = 392;

/** x of each axle, and the tire bands (y) for single and dual axles. */
const AXLE_X: Record<TirePosition['axle'], number> = { S: 112, D1: 318, D2: 384, T1: 846, T2: 906 };
const TIRE_LEN = 50;
const BAND = {
  // Steer: one wide tire a side.
  S: { R: [100, 140], L: [282, 322] },
  // Duals: outer is the furthest from the body.
  O: { R: [92, 115], L: [307, 330] },
  I: { R: [118, 141], L: [281, 304] },
} as const;
const BADGE_W = 36;
const BADGE_H = 20;
const BADGE_Y = {
  S: { R: 66, L: 336 },
  O: { R: 42, L: 360 },
  I: { R: 66, L: 336 },
} as const;

export interface TireGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
  badgeX: number;
  badgeY: number;
}

export const TIRE_GEOMETRY: Record<TirePositionKey, TireGeometry> = Object.fromEntries(
  TIRE_POSITIONS.map((p) => {
    const cx = AXLE_X[p.axle];
    const band = p.dual ? BAND[p.dual][p.side] : BAND.S[p.side];
    const by = p.dual ? BADGE_Y[p.dual][p.side] : BADGE_Y.S[p.side];
    return [p.id, { x: cx - TIRE_LEN / 2, y: band[0], w: TIRE_LEN, h: band[1] - band[0], badgeX: cx - BADGE_W / 2, badgeY: by }];
  }),
) as Record<TirePositionKey, TireGeometry>;

/** Heat for a count in the current view: none, then light to deep, relative to the max. */
export function heat(count: number, max: number): { fill: string; text: string; ring: string } | null {
  if (count <= 0 || max <= 0) return null;
  const t = Math.max(0.12, Math.min(1, count / max));
  const pct = Math.round(15 + t * 85);
  return {
    fill: `color-mix(in oklab, var(--nw-urgent-icon) ${pct}%, var(--nw-warning-bg))`,
    text: t > 0.5 ? 'var(--nw-on-danger)' : 'var(--nw-urgent-text)',
    ring: `color-mix(in oklab, var(--nw-urgent-icon) ${pct}%, transparent)`,
  };
}

const v = (name: string) => `var(--nw-${name})`;
const stop = (offset: string, color: string, opacity = 1) => <stop offset={offset} style={{ stopColor: color, stopOpacity: opacity }} />;

export interface TireTruckSvgProps {
  counts?: Partial<Record<TirePositionKey, number>>;
  max?: number;
  selected?: ReadonlySet<TirePositionKey>;
  onSelect?: (id: TirePositionKey) => void;
  onHover?: (id: TirePositionKey | null) => void;
  /** Hide the count badges (the small tagging map). */
  badges?: boolean;
  /** Positions that cannot be picked here (faded, not clickable). */
  disabled?: ReadonlySet<TirePositionKey>;
  /** Write the short code on each tire (L, R, LO, RI …), as the work order picker does. */
  codes?: boolean;
  /** How a badge writes its value (counts as they are; spend as "$3.5k"). */
  format?: (n: number) => string;
  /** Group and axle headings above the drawing. */
  headings?: boolean;
  className?: string;
  style?: CSSProperties;
  ariaLabel?: string;
}

export function TireTruckSvg({
  counts = {},
  max = 0,
  selected,
  onSelect,
  onHover,
  badges = true,
  disabled,
  codes = false,
  format = String,
  headings = true,
  className,
  style,
  ariaLabel = 'Tire positions, top view, front of the truck to the left',
}: TireTruckSvgProps) {
  return (
    <svg viewBox={`0 0 ${VIEW_W} ${VIEW_H}`} className={className} style={style} role="group" aria-label={ariaLabel}>
      <defs>
        <linearGradient id="nw-cab" x1="0" y1="0" x2="0" y2="1">
          {stop('0', v('accent'))}
          {stop('0.5', v('accent-ink'))}
          {stop('1', v('accent'))}
        </linearGradient>
        <linearGradient id="nw-hood" x1="0" y1="0" x2="1" y2="0">
          {stop('0', v('accent-ink'))}
          {stop('1', v('accent'))}
        </linearGradient>
        <linearGradient id="nw-van" x1="0" y1="0" x2="0" y2="1">
          {stop('0', v('subtle'))}
          {stop('0.18', v('panel'))}
          {stop('0.82', v('panel'))}
          {stop('1', v('subtle'))}
        </linearGradient>
        <linearGradient id="nw-tire" x1="0" y1="0" x2="0" y2="1">
          {stop('0', v('text-2'))}
          {stop('0.5', v('text'))}
          {stop('1', v('text-2'))}
        </linearGradient>
        <linearGradient id="nw-glass" x1="0" y1="0" x2="1" y2="0">
          {stop('0', v('text'), 0.85)}
          {stop('1', v('text-2'), 0.7)}
        </linearGradient>
      </defs>

      {headings ? <Headings /> : null}

      {/* Side labels. */}
      <g fill={v('text-3')} fontSize="11" fontWeight={700} letterSpacing=".08em">
        <text transform="translate(16 150) rotate(-90)" textAnchor="middle">PASSENGER (RH) ↑</text>
        <text transform="translate(16 290) rotate(-90)" textAnchor="middle">↓ DRIVER (LH)</text>
      </g>

      {/* ------------------------------------------------------------ chassis under the bodies */}
      <g>
        {/* Frame rails from the cab to the end of the tractor. */}
        <rect x="150" y="186" width="282" height="9" rx="3" fill={v('text-2')} />
        <rect x="150" y="225" width="282" height="9" rx="3" fill={v('text-2')} />
        {/* Axles and their hubs. */}
        {(['S', 'D1', 'D2', 'T1', 'T2'] as const).map((a) => (
          <g key={a}>
            <rect x={AXLE_X[a] - 4} y={a === 'S' ? 132 : 112} width="8" height={a === 'S' ? 156 : 196} rx="3" fill={v('text-2')} />
            {a === 'D1' || a === 'D2' ? <ellipse cx={AXLE_X[a]} cy={210} rx="13" ry="17" fill={v('text-2')} stroke={v('text-3')} strokeWidth="2" /> : null}
          </g>
        ))}
        {/* Drive shaft. */}
        <rect x="240" y="207" width="146" height="6" rx="3" fill={v('text-3')} />
        {/* Fifth wheel. */}
        <circle cx="352" cy="210" r="30" fill={v('text-3')} stroke={v('text-2')} strokeWidth="3" />
        <path d="M352 210 L384 202 L384 218 Z" fill={v('text-2')} />
        <circle cx="352" cy="210" r="7" fill={v('text-2')} />
        {/* Mud flaps behind the rear drive axle. */}
        <rect x="414" y="96" width="5" height="44" rx="2" fill={v('text')} />
        <rect x="414" y="280" width="5" height="44" rx="2" fill={v('text')} />
        {/* Trailer sub-frame, slider and its mud flaps. */}
        <rect x="806" y="186" width="140" height="9" rx="3" fill={v('text-2')} />
        <rect x="806" y="225" width="140" height="9" rx="3" fill={v('text-2')} />
        <rect x="944" y="96" width="5" height="44" rx="2" fill={v('text')} />
        <rect x="944" y="280" width="5" height="44" rx="2" fill={v('text')} />
      </g>

      {/* ------------------------------------------------------------ tires (layer 1) */}
      <g>
        {TIRE_POSITIONS.map((p) => (
          <Tire key={p.id} g={TIRE_GEOMETRY[p.id]} heatRing={heat(counts[p.id] ?? 0, max)?.ring ?? null} selected={selected?.has(p.id) ?? false} faded={disabled?.has(p.id) ?? false} code={codes ? `${p.side}${p.dual ?? ''}` : null} />
        ))}
      </g>

      {/* ------------------------------------------------------------ tractor */}
      <g>
        {/* Fuel tanks and steps under the cab. */}
        <rect x="160" y="138" width="78" height="14" rx="7" fill={v('border-strong')} stroke={v('text-3')} strokeWidth="1" />
        <rect x="160" y="268" width="78" height="14" rx="7" fill={v('border-strong')} stroke={v('text-3')} strokeWidth="1" />
        {/* Bumper. */}
        <rect x="30" y="158" width="14" height="104" rx="6" fill={v('border-strong')} stroke={v('text-3')} strokeWidth="1.5" />
        {/* Hood, tapering to the nose. */}
        <path d="M44 172 Q44 150 70 148 L156 144 L156 276 L70 272 Q44 270 44 248 Z" fill="url(#nw-hood)" stroke={v('accent-ink')} strokeWidth="1.5" />
        <path d="M60 210 L150 210" stroke={v('accent-tint')} strokeOpacity=".45" strokeWidth="2" />
        <path d="M58 168 Q100 160 150 158 M58 252 Q100 260 150 262" stroke={v('accent-tint')} strokeOpacity=".3" strokeWidth="1.5" fill="none" />
        {/* Headlights. */}
        <rect x="46" y="160" width="10" height="18" rx="3" fill={v('warning-bg')} />
        <rect x="46" y="242" width="10" height="18" rx="3" fill={v('warning-bg')} />
        {/* Mirrors on their arms. */}
        <path d="M150 142 L142 122" stroke={v('text-2')} strokeWidth="2.5" />
        <rect x="134" y="108" width="12" height="18" rx="3" fill={v('text-2')} />
        <path d="M150 278 L142 298" stroke={v('text-2')} strokeWidth="2.5" />
        <rect x="134" y="294" width="12" height="18" rx="3" fill={v('text-2')} />
        {/* Cab. */}
        <rect x="154" y="142" width="76" height="136" rx="10" fill="url(#nw-cab)" stroke={v('accent-ink')} strokeWidth="1.5" />
        <rect x="158" y="152" width="16" height="116" rx="5" fill="url(#nw-glass)" />
        <rect x="180" y="150" width="44" height="120" rx="7" fill={v('accent-ink')} fillOpacity=".55" />
        <rect x="186" y="186" width="30" height="48" rx="5" fill={v('accent')} fillOpacity=".35" />
        {/* Sleeper with its roof fairing. */}
        <rect x="228" y="146" width="74" height="128" rx="8" fill="url(#nw-cab)" stroke={v('accent-ink')} strokeWidth="1.5" />
        <rect x="236" y="154" width="58" height="112" rx="6" fill={v('accent-ink')} fillOpacity=".4" />
        <path d="M244 166 L286 166 M244 254 L286 254" stroke={v('accent-tint')} strokeOpacity=".35" strokeWidth="1.5" />
        <rect x="248" y="196" width="22" height="28" rx="4" fill={v('accent-tint')} fillOpacity=".25" />
        {/* Marker lights along the roof. */}
        {[170, 190, 230, 250].map((y) => (
          <circle key={y} cx="232" cy={y} r="2" fill={v('warning-bg')} />
        ))}
        {/* Exhaust stacks behind the sleeper. */}
        <circle cx="306" cy="150" r="5" fill={v('border-strong')} stroke={v('text-3')} />
        <circle cx="306" cy="270" r="5" fill={v('border-strong')} stroke={v('text-3')} />
      </g>

      {/* ------------------------------------------------------------ 53-foot dry van */}
      <g>
        <rect x="436" y="142" width="538" height="136" rx="4" fill="url(#nw-van)" stroke={v('border-strong')} strokeWidth="2" />
        {/* Roof bows. */}
        {Array.from({ length: 17 }, (_, i) => 466 + i * 30).map((x) => (
          <line key={x} x1={x} y1="146" x2={x} y2="274" stroke={v('border')} strokeWidth="1.2" />
        ))}
        {/* Side rails, front panel and rear doors. */}
        <line x1="440" y1="148" x2="970" y2="148" stroke={v('border-strong')} strokeWidth="1.2" />
        <line x1="440" y1="272" x2="970" y2="272" stroke={v('border-strong')} strokeWidth="1.2" />
        <rect x="436" y="142" width="14" height="136" rx="3" fill={v('subtle')} stroke={v('border-strong')} />
        <rect x="962" y="142" width="12" height="136" rx="2" fill={v('subtle')} stroke={v('border-strong')} />
        <line x1="968" y1="146" x2="968" y2="274" stroke={v('border-strong')} />
        {/* Kingpin over the fifth wheel's line, and the landing gear. */}
        <circle cx="462" cy="210" r="5" fill={v('text-3')} />
        <rect x="540" y="150" width="10" height="16" rx="2" fill={v('text-3')} />
        <rect x="540" y="254" width="10" height="16" rx="2" fill={v('text-3')} />
        {/* Corner and side marker lights. */}
        {[600, 700, 800].map((x) => (
          <g key={x}>
            <rect x={x} y="143" width="8" height="3" rx="1" fill={v('warning-icon')} />
            <rect x={x} y="274" width="8" height="3" rx="1" fill={v('warning-icon')} />
          </g>
        ))}
        <rect x="968" y="144" width="4" height="10" rx="1" fill={v('urgent-icon')} />
        <rect x="968" y="266" width="4" height="10" rx="1" fill={v('urgent-icon')} />
      </g>

      {/* ------------------------------------------------------------ count badges (layer 2) */}
      {badges ? (
        <g aria-hidden>
          {TIRE_POSITIONS.map((p) => {
            const g = TIRE_GEOMETRY[p.id];
            const count = counts[p.id] ?? 0;
            const h = heat(count, max);
            const isSel = selected?.has(p.id) ?? false;
            return (
              <g key={p.id}>
                <rect
                  x={g.badgeX}
                  y={g.badgeY}
                  width={BADGE_W}
                  height={BADGE_H}
                  rx="5"
                  style={{ fill: h?.fill ?? v('subtle'), stroke: isSel ? v('accent') : h ? 'none' : v('border-strong'), strokeWidth: isSel ? 2.5 : 1 }}
                />
                <text
                  x={g.badgeX + BADGE_W / 2}
                  y={g.badgeY + BADGE_H / 2 + 4.5}
                  textAnchor="middle"
                  fontSize="12.5"
                  fontWeight={800}
                  style={{ fill: h?.text ?? v('text-3') }}
                >
                  {format(count)}
                </text>
              </g>
            );
          })}
        </g>
      ) : null}

      {/* ------------------------------------------------------------ click targets (layer 3) */}
      {onSelect ? (
        <g>
          {TIRE_POSITIONS.filter((p) => !disabled?.has(p.id)).map((p) => {
            const g = TIRE_GEOMETRY[p.id];
            const isSel = selected?.has(p.id) ?? false;
            const common = {
              fill: 'transparent',
              className: 'cursor-pointer',
              onClick: () => onSelect(p.id),
              onMouseEnter: () => onHover?.(p.id),
              onMouseLeave: () => onHover?.(null),
              'data-position': p.id,
            };
            return (
              <g key={p.id}>
                {/* The tire itself is the keyboard stop; the badge is a second, mouse-only target. */}
                <rect
                  {...common}
                  x={g.x - 3}
                  y={g.y - 1}
                  width={g.w + 6}
                  height={g.h + 2}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSel}
                  aria-label={`${tirePositionLabel(p.id)}: ${counts[p.id] ?? 0}`}
                  className="cursor-pointer outline-none focus-visible:stroke-nw-accent focus-visible:[stroke-width:2]"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onSelect(p.id);
                    }
                  }}
                  onFocus={() => onHover?.(p.id)}
                  onBlur={() => onHover?.(null)}
                />
                {badges ? <rect {...common} x={g.badgeX - 2} y={g.badgeY - 2} width={BADGE_W + 4} height={BADGE_H + 4} aria-hidden /> : null}
              </g>
            );
          })}
        </g>
      ) : null}
    </svg>
  );
}

function Tire({ g, heatRing, selected, faded = false, code = null }: { g: TireGeometry; heatRing: string | null; selected: boolean; faded?: boolean; code?: string | null }) {
  const treads: ReactNode[] = [];
  for (let x = g.x + 6; x < g.x + g.w - 3; x += 6)
    treads.push(<line key={x} x1={x} y1={g.y + 2} x2={x} y2={g.y + g.h - 2} stroke={v('text-3')} strokeOpacity=".55" strokeWidth="1.2" />);
  return (
    <g opacity={faded ? 0.25 : 1}>
      {heatRing || selected ? (
        <rect
          x={g.x - 3}
          y={g.y - 3}
          width={g.w + 6}
          height={g.h + 6}
          rx="8"
          fill="none"
          style={{ stroke: selected ? v('accent') : (heatRing ?? 'none'), strokeWidth: selected ? 3 : 2.5 }}
        />
      ) : null}
      <rect x={g.x} y={g.y} width={g.w} height={g.h} rx="6" fill="url(#nw-tire)" />
      {treads}
      {code ? (
        <>
          <rect x={g.x + g.w / 2 - 11} y={g.y + g.h / 2 - 7} width="22" height="14" rx="3" fill={selected ? v('accent') : v('panel')} />
          <text x={g.x + g.w / 2} y={g.y + g.h / 2 + 3.5} textAnchor="middle" fontSize="10" fontWeight={800} fill={selected ? v('on-accent') : v('text')}>
            {code}
          </text>
        </>
      ) : (
        <rect x={g.x + g.w / 2 - 7} y={g.y + g.h / 2 - 3} width="14" height="6" rx="2" fill={v('text-3')} />
      )}
    </g>
  );
}

function Headings() {
  const group = (x: number, label: string) => (
    <text x={x} y="16" textAnchor="middle" fontSize="12" fontWeight={800} letterSpacing=".06em" fill={v('text')}>
      {label}
    </text>
  );
  const axle = (x: number, label: string) => (
    <text x={x} y="34" textAnchor="middle" fontSize="10" fontWeight={700} letterSpacing=".06em" fill={v('text-3')}>
      {label}
    </text>
  );
  return (
    <g>
      {group(AXLE_X.S, 'STEER')}
      {group((AXLE_X.D1 + AXLE_X.D2) / 2, 'DRIVE')}
      {axle(AXLE_X.D1, 'AXLE 1')}
      {axle(AXLE_X.D2, 'AXLE 2')}
      {group((AXLE_X.T1 + AXLE_X.T2) / 2, 'TRAILER')}
      {axle(AXLE_X.T1, 'AXLE 1')}
      {axle(AXLE_X.T2, 'AXLE 2')}
    </g>
  );
}
