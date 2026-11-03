import { divIcon, latLngBounds } from 'leaflet';
import { useEffect, useMemo, useState } from 'react';
import { MapContainer, Marker, Popup, TileLayer, useMap } from 'react-leaflet';
import 'leaflet/dist/leaflet.css';
import './fleet-position-map.css';
import type { TrackingState } from '@neway/shared';
import { cn } from '@/design-system';
import { MapOptions } from './MapOptions';
import {
  BASE_TILES,
  OVERLAY_TILES,
  latestRadarTiles,
  loadView,
  saveView,
  type MapView,
} from './map-layers';

/**
 * Fleet position map — the NWF live-map look on a real basemap.
 *
 * Carto's light tiles keep the page's quiet palette, and its dark tiles take over in dark mode
 * (SPEC §7 "Maps"); each unit is a pill marker carrying its number, coloured by state, and the
 * map fits itself to wherever the fleet actually is. Selecting a unit (list or marker) flies to
 * it and opens its popup.
 */

export interface MapUnit {
  id: string;
  unitNumber: string;
  lat: number;
  lng: number;
  city: string;
  state: string;
  /** Drives the marker colour. */
  tone: 'active' | 'at_risk' | 'available' | 'stale' | 'held';
  tracking: TrackingState;
  /**
   * Whether the truck is rolling. Filled dot when it is, hollow when it is not — shape, so the
   * two are told apart without reading the colour. There is no heading in the position feed, so
   * the marker does not pretend to point anywhere.
   *
   * Optional: a caller with no speed to hand says nothing rather than guessing, and a unit whose
   * motion is unknown reads as not moving.
   */
  /**
   * What the unit is doing: rolling, idling, or stopped.
   *
   * This is what colours the marker, because it is the question the map answers — the panel
   * beside it counts the fleet the same three ways. `tone` still decides the popup's wording.
   */
  motion?: 'rolling' | 'idle' | 'stopped';
  moving?: boolean;
  /**
   * Degrees clockwise from north, when the position feed reported one.
   *
   * With a heading the unit is drawn as an arrow pointing the way it is going, like the ELD's own
   * map. Without one it stays a dot: an arrow that points somewhere it was never told looks right
   * and is wrong, and a dispatcher would believe it.
   */
  headingDegrees?: number | null;
  label: string;
}

type ResolvedTheme = 'light' | 'dark';

function readTheme(): ResolvedTheme {
  if (typeof document === 'undefined') return 'light';
  const attr = document.documentElement.getAttribute('data-theme');
  if (attr === 'dark' || attr === 'light') return attr;
  return typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches
    ? 'dark'
    : 'light';
}

/**
 * The theme the page is actually painted in. Appearance changes fire `neway:appearance` on the
 * window after `data-theme` is written, so the tiles can swap without a reload.
 */
function useResolvedTheme(): ResolvedTheme {
  const [theme, setTheme] = useState<ResolvedTheme>(readTheme);
  useEffect(() => {
    const update = () => setTheme(readTheme());
    window.addEventListener('neway:appearance', update);
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    media?.addEventListener?.('change', update);
    return () => {
      window.removeEventListener('neway:appearance', update);
      media?.removeEventListener?.('change', update);
    };
  }, []);
  return theme;
}

/** Carto basemaps: the provider's own light and dark styles (SPEC §8 "Maps use dark tiles"). */
/**
 * Where the map picture comes from.
 *
 * Carto's basemaps began requiring an API key, and every tile came back as a grey
 * "API KEY REQUIRED" watermark - the map was unreadable in both modes. Esri's basemaps are
 * keyless. Light mode uses the topographic map - relief, water, forests and place names in colour, the
 * picture a dispatcher knows from the ELD's own map; the grey canvas it replaced (owner,
 * 2026-09-18: "make the map colourful") left the fleet floating on a blank. Dark mode keeps
 * Esri's dark canvas, the only keyless dark style, as the design asks. Either URL can be
 * replaced from the environment, so a Carto or Mapbox key can be dropped in without a code
 * change; `{s}` subdomains are Carto's, and Esri does not use them.
 */
const TILES: Record<ResolvedTheme, string> = {
  // OpenStreetMap's own style (owner, 2026-10-10): the closest keyless picture to the ELD's map.
  light: import.meta.env.VITE_MAP_TILES_LIGHT ?? 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  dark:
    import.meta.env.VITE_MAP_TILES_DARK ??
    'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
};

const TILE_ATTRIBUTION =
  import.meta.env.VITE_MAP_TILES_ATTRIBUTION ?? '&copy; OpenStreetMap contributors &middot; Esri';

/**
 * Marker colours as CSS variables, not copied hex.
 *
 * Leaflet takes an HTML string for a marker, but that string is rendered in the document, so
 * `var(--nw-...)` resolves normally - which keeps the map on the same palette as everything
 * else instead of freezing five values that drift the next time the tokens move. The mapping
 * is the product's tone → Porcelain family: active → accent, at risk → danger, available →
 * done, stale → warning, held → neutral.
 */
const TONE_BG: Record<MapUnit['tone'], string> = {
  active: 'var(--nw-accent)',
  at_risk: 'var(--nw-danger)',
  available: 'var(--nw-done-icon)',
  stale: 'var(--nw-warning-icon)',
  held: 'var(--nw-neutral-icon)',
};

const TONE_LABEL: Record<MapUnit['tone'], string> = {
  active: 'On a load',
  at_risk: 'At risk',
  available: 'Available',
  stale: 'Tracking stale',
  held: 'Held',
};

/** Motion decides the colour: the three the panel counts, in the three families that mean them. */
const MOTION_COLOUR: Record<'rolling' | 'idle' | 'stopped', string> = {
  rolling: 'var(--nw-done-icon)',
  idle: 'var(--nw-warning-icon)',
  stopped: 'var(--nw-neutral-icon)',
};

/**
 * A unit on the map: an arrow when it is rolling, a filled disc when it is not.
 *
 * The arrow is the picture a dispatcher already knows from the ELD — which way is this truck
 * going. It points along the heading the feed reported; a rolling truck whose feed sent none is
 * still an arrow, pointing up, because "moving" is the thing worth seeing at a glance and the
 * hover says the speed. Idling and stopped units have no direction to claim, so they are discs.
 *
 * Every marker carries a panel-coloured ring so it stands off the basemap at any zoom.
 */
function unitIcon(unit: MapUnit, selected: boolean) {
  const motion = unit.motion ?? (unit.moving ? 'rolling' : 'stopped');
  const colour = MOTION_COLOUR[motion];
  const title = escapeAttribute(unit.label);
  const halo = selected ? 'filter:drop-shadow(0 0 5px var(--nw-accent));' : '';

  if (motion === 'rolling') {
    const size = selected ? 28 : 21;
    const heading = unit.headingDegrees;
    const angle = heading === null || heading === undefined ? 0 : Math.round(heading);
    return divIcon({
      className: '',
      // Rotated about its own centre, so the point leads and the marker stays over the position.
      html:
        `<span title="${title}" style="display:block;width:${size}px;height:${size}px;` +
        `transform:translate(-50%,-50%) rotate(${angle}deg);${halo}">` +
        `<svg viewBox="0 0 24 24" width="${size}" height="${size}" aria-hidden="true">` +
        `<path d="M12 2 L20.5 21.5 L12 16.6 L3.5 21.5 Z" fill="${colour}" ` +
        `stroke="var(--nw-panel)" stroke-width="1.6" stroke-linejoin="round"/></svg></span>`,
      iconSize: [0, 0],
    });
  }

  const size = selected ? 17 : 12;
  return divIcon({
    className: '',
    // The `title` is the browser's own tooltip: the unit number without a click, no library.
    html:
      `<span title="${title}" style="display:block;` +
      `width:${size}px;height:${size}px;border-radius:9999px;` +
      `background:${colour};border:2px solid var(--nw-panel);` +
      `box-shadow:var(--nw-shadow-segment)${selected ? ',0 0 0 4px var(--nw-accent-tint)' : ''};` +
      `transform:translate(-50%,-50%);"></span>`,
    iconSize: [0, 0],
  });
}

/** The label goes into an HTML attribute, so the quotes and angle brackets in it must not. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** Fits the fleet on first paint, then flies to whichever unit is selected. */
function MapCamera({ units, selected }: { units: MapUnit[]; selected: MapUnit | null }) {
  const map = useMap();
  const fitKey = units.length;
  useEffect(() => {
    if (units.length === 0) return;
    map.fitBounds(latLngBounds(units.map((u) => [u.lat, u.lng])), {
      padding: [40, 40],
      maxZoom: 8,
    });
    // refit only when the visible set changes size (filter/search), not every poll
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, fitKey]);
  useEffect(() => {
    if (selected) map.flyTo([selected.lat, selected.lng], Math.max(map.getZoom(), 8));
  }, [map, selected]);
  return null;
}

/**
 * What the markers mean, now that they mean motion.
 *
 * It described the load tones while the markers were coloured by them; the markers say rolling,
 * idling or stopped, so the legend says the same. A legend that explains a colour the map no
 * longer uses is worse than none.
 */
const MOTION_LEGEND: { motion: 'rolling' | 'idle' | 'stopped'; label: string }[] = [
  { motion: 'rolling', label: 'Rolling' },
  { motion: 'idle', label: 'Idling' },
  { motion: 'stopped', label: 'Stopped' },
];

export function MapLegend() {
  return (
    <>
      {MOTION_LEGEND.map(({ motion, label }) => (
        <span key={motion} className="inline-flex items-center gap-1.5">
          {motion === 'rolling' ? (
            <svg viewBox="0 0 24 24" width={11} height={11} aria-hidden>
              <path
                d="M12 2 L20.5 21.5 L12 16.6 L3.5 21.5 Z"
                fill={MOTION_COLOUR[motion]}
                stroke="var(--nw-panel)"
                strokeWidth="1.6"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <span
              aria-hidden
              className="inline-block size-2.5 rounded-full"
              style={{ backgroundColor: MOTION_COLOUR[motion] }}
            />
          )}
          {label}
        </span>
      ))}
    </>
  );
}

/**
 * Leaflet sizes its tile grid once and positions every marker against that size. A container
 * that grows or shrinks afterwards - the sidebar collapsing, the window resizing, a taller
 * height prop - leaves markers drawn against the old box, which is how they ended up outside
 * the map. The container is watched, not just the window, so a layout change with no window
 * event still re-measures.
 */
function MapResize({ height }: { height: number }) {
  const map = useMap();
  useEffect(() => {
    map.invalidateSize();
  }, [map, height]);
  useEffect(() => {
    const container = map.getContainer();
    const refresh = () => map.invalidateSize();
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => refresh());
    observer?.observe(container);
    window.addEventListener('resize', refresh);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', refresh);
    };
  }, [map]);
  return null;
}

export interface FleetPositionMapProps {
  units: MapUnit[];
  selectedUnit?: string;
  onSelect: (unitNumber: string) => void;
  /** Units the system holds no position for; reported rather than silently dropped. */
  unpositioned: number;
  /** Map height in pixels. Default 560. */
  height?: number;
  /** Render the colour legend under the map. Default on; off when the page draws its own. */
  showLegend?: boolean;
  /** Full-bleed: no corners, fills its box. The Live map page; not a unit's card. */
  full?: boolean;
}

export function FleetPositionMap({
  units,
  selectedUnit,
  onSelect,
  unpositioned,
  height = 560,
  showLegend = true,
  full = false,
}: FleetPositionMapProps) {
  const theme = useResolvedTheme();
  const selected = useMemo(
    () => units.find((u) => u.unitNumber === selectedUnit) ?? null,
    [units, selectedUnit],
  );
  const [view, setView] = useState<MapView>(loadView);
  const changeView = (next: MapView) => {
    setView(next);
    saveView(next);
  };
  const radar = useRadar(view.overlays.includes('weather'));
  const baseUrl = view.base === 'default' ? TILES[theme] : BASE_TILES[view.base];
  return (
    <div className={cn('flex flex-col gap-2', full && 'h-full')}>
      {/* `isolate` boxes Leaflet's own z-indices (panes 400, controls 1000) under the app's overlays. */}
      {/* `relative overflow-hidden` clips Leaflet's panes to the box: a marker positioned past the
          edge is cut, never drawn over the page around the map. */}
      {/* No frame: the map is the page here, and a border around a full-bleed map reads as a
          picture of a map rather than the live thing. The rounded corners stay so it sits in the
          layout; `overflow-hidden` still clips Leaflet's panes. */}
      <div
        className={cn(
          'nw-map relative isolate overflow-hidden',
          // Full-bleed on the Live map page; rounded where it sits inside a unit's card.
          full ? 'h-full' : 'rounded-lg',
        )}
      >
        <MapContainer
          center={[39, -96]}
          zoom={4}
          scrollWheelZoom
          style={{ height, width: '100%' }}
          // OpenStreetMap's tile policy asks for the credit on the map itself.
          attributionControl
        >
          {/* Keyed on the theme so Leaflet rebuilds the tile grid instead of caching the old URL. */}
          <TileLayer key={baseUrl} url={baseUrl} attribution={TILE_ATTRIBUTION} maxZoom={19} />
          {view.overlays.includes('labels') ? (
            <TileLayer key="labels" url={OVERLAY_TILES.labels} zIndex={3} />
          ) : null}
          {view.overlays.includes('roads') ? (
            <TileLayer key="roads" url={OVERLAY_TILES.roads} zIndex={2} />
          ) : null}
          {radar ? (
            // The free radar goes to zoom 7; closer in, the same picture is stretched.
            <TileLayer key={radar.url} url={radar.url} opacity={0.65} maxNativeZoom={7} zIndex={4} />
          ) : null}
          <MapResize height={height} />
          <MapCamera units={units} selected={selected} />
          {units.map((unit) => (
            <Marker
              key={unit.id}
              position={[unit.lat, unit.lng]}
              icon={unitIcon(unit, unit.unitNumber === selectedUnit)}
              eventHandlers={{ click: () => onSelect(unit.unitNumber) }}
            >
              <Popup>
                <div className="min-w-40 text-xs text-nw-text">
                  <div className="mb-0.5 font-bold">Unit {unit.unitNumber}</div>
                  <div className="text-nw-text-2">
                    {unit.city}, {unit.state}
                  </div>
                  <div className="mt-1 font-semibold" style={{ color: TONE_BG[unit.tone] }}>
                    {TONE_LABEL[unit.tone]}
                  </div>
                  <div className="mt-0.5 text-nw-text-3">{unit.label}</div>
                </div>
              </Popup>
            </Marker>
          ))}
        </MapContainer>
        <MapOptions view={view} onChange={changeView} radarTime={radar?.time ?? null} />
      </div>
      {showLegend ? (
        <div className="flex flex-wrap items-center gap-3 text-xs text-nw-text-3">
          <MapLegend />
          {unpositioned > 0 ? (
            <span className="ml-auto">{unpositioned} unit(s) with no reported position</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

/** The newest radar frame while the weather layer is on, refreshed every ten minutes. */
function useRadar(on: boolean): { url: string; time: number } | null {
  const [frame, setFrame] = useState<{ url: string; time: number } | null>(null);
  useEffect(() => {
    if (!on) return;
    let live = true;
    const load = () =>
      void latestRadarTiles().then((next) => {
        if (live && next) setFrame(next);
      });
    load();
    const timer = window.setInterval(load, 10 * 60 * 1000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [on]);
  return on ? frame : null;
}
