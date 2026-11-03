/**
 * The Live map's picture, the way the ELD's own map offers it (owner, 2026-10-10): a base map to
 * choose and overlays to switch on. Samsara's API sends positions, not map pictures - its map is
 * Google's - so the same views come from keyless providers: Esri for the base maps and labels,
 * RainViewer for the weather radar.
 */

export type MapBase = 'default' | 'terrain' | 'satellite';
export type MapOverlay = 'weather' | 'labels' | 'roads';

export interface MapView {
  base: MapBase;
  overlays: MapOverlay[];
}

const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services';

/** Satellite and terrain look the same in both themes; only the default map follows dark mode. */
export const BASE_TILES: Record<Exclude<MapBase, 'default'>, string> = {
  terrain: `${ESRI}/World_Topo_Map/MapServer/tile/{z}/{y}/{x}`,
  satellite: `${ESRI}/World_Imagery/MapServer/tile/{z}/{y}/{x}`,
};

/** Transparent layers drawn over any base. */
export const OVERLAY_TILES: Record<Exclude<MapOverlay, 'weather'>, string> = {
  labels: `${ESRI}/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}`,
  roads: `${ESRI}/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}`,
};

export const BASE_LABEL: Record<MapBase, string> = {
  default: 'Default',
  terrain: 'Terrain',
  satellite: 'Satellite',
};

export const OVERLAY_LABEL: Record<MapOverlay, string> = {
  weather: 'Weather',
  labels: 'Places & borders',
  roads: 'Highways',
};

export const DEFAULT_VIEW: MapView = { base: 'default', overlays: [] };

const KEY = 'neway:live-map-view';
const BASES: readonly MapBase[] = ['default', 'terrain', 'satellite'];
const OVERLAYS: readonly MapOverlay[] = ['weather', 'labels', 'roads'];

/** The viewer's last choice; a convenience only, so anything unreadable falls back to the default. */
export function loadView(): MapView {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? 'null') as Partial<MapView> | null;
    if (!raw) return DEFAULT_VIEW;
    return {
      base: BASES.includes(raw.base as MapBase) ? (raw.base as MapBase) : 'default',
      overlays: Array.isArray(raw.overlays)
        ? raw.overlays.filter((o): o is MapOverlay => OVERLAYS.includes(o as MapOverlay))
        : [],
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(view: MapView): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(view));
  } catch {
    // Private windows and blocked storage just forget the choice.
  }
}

/** RainViewer's newest radar frame, as a tile URL; null when the service cannot be reached. */
export async function latestRadarTiles(): Promise<{ url: string; time: number } | null> {
  try {
    const res = await fetch('https://api.rainviewer.com/public/weather-maps.json');
    if (!res.ok) return null;
    const data = (await res.json()) as {
      host?: string;
      radar?: { past?: Array<{ time: number; path: string }> };
    };
    const frame = data.radar?.past?.at(-1);
    if (!data.host || !frame) return null;
    // 256px tiles, colour scheme 2 (the familiar green-yellow-red), smoothed, snow shown.
    return { url: `${data.host}${frame.path}/256/{z}/{x}/{y}/2/1_1.png`, time: frame.time };
  } catch {
    return null;
  }
}
