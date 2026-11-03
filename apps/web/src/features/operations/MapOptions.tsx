import { useState } from 'react';
import { Layers, X } from 'lucide-react';
import { cn } from '@/design-system';
import {
  BASE_LABEL,
  OVERLAY_LABEL,
  type MapBase,
  type MapOverlay,
  type MapView,
} from './map-layers';

const BASES: MapBase[] = ['default', 'terrain', 'satellite'];
const OVERLAYS: MapOverlay[] = ['weather', 'labels', 'roads'];

/**
 * The map's layer button and its panel, laid out like the ELD's "Map options": the base map as
 * a choice of one, the overlays as switches. It sits beside the map rather than inside Leaflet's
 * container, so a click on it never pans or zooms the map underneath.
 */
export function MapOptions({
  view,
  onChange,
  radarTime,
}: {
  view: MapView;
  onChange: (next: MapView) => void;
  /** When the radar picture was taken (epoch seconds), once the weather layer has one. */
  radarTime: number | null;
}) {
  const [open, setOpen] = useState(false);
  const toggle = (overlay: MapOverlay) =>
    onChange({
      ...view,
      overlays: view.overlays.includes(overlay)
        ? view.overlays.filter((o) => o !== overlay)
        : [...view.overlays, overlay],
    });

  return (
    <div className="absolute top-3 right-3 z-[1000] flex flex-col items-end gap-2">
      <button
        type="button"
        aria-label="Map options"
        aria-expanded={open}
        title="Map options"
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'grid size-10 place-items-center rounded-lg border border-nw-border bg-nw-panel text-nw-text shadow-(--nw-shadow-menu) hover:bg-nw-hover',
          open && 'border-nw-accent text-nw-accent-ink',
        )}
      >
        {open ? <X className="size-5" aria-hidden /> : <Layers className="size-5" aria-hidden />}
      </button>
      {open ? (
        <div
          role="dialog"
          aria-label="Map options"
          className="w-56 rounded-lg border border-nw-border bg-nw-panel p-3 text-sm text-nw-text shadow-(--nw-shadow-menu)"
        >
          <fieldset>
            <legend className="mb-1.5 text-[11px] font-bold tracking-wide text-nw-text-3 uppercase">
              Map base
            </legend>
            {BASES.map((base) => (
              <label key={base} className="flex cursor-pointer items-center gap-2.5 py-1">
                <input
                  type="radio"
                  name="map-base"
                  checked={view.base === base}
                  onChange={() => onChange({ ...view, base })}
                  className="size-4 accent-(--nw-accent)"
                />
                {BASE_LABEL[base]}
              </label>
            ))}
          </fieldset>
          <fieldset className="mt-3 border-t border-nw-border pt-3">
            <legend className="sr-only">Overlay</legend>
            <span
              aria-hidden
              className="mb-1.5 block text-[11px] font-bold tracking-wide text-nw-text-3 uppercase"
            >
              Overlay
            </span>
            {OVERLAYS.map((overlay) => (
              <label key={overlay} className="flex cursor-pointer items-center gap-2.5 py-1">
                <input
                  type="checkbox"
                  checked={view.overlays.includes(overlay)}
                  onChange={() => toggle(overlay)}
                  className="size-4 accent-(--nw-accent)"
                />
                {OVERLAY_LABEL[overlay]}
              </label>
            ))}
          </fieldset>
          {view.overlays.includes('weather') ? (
            <p className="mt-2 text-xs text-nw-text-3">
              {radarTime
                ? `Radar ${new Date(radarTime * 1000).toLocaleTimeString('en-US', {
                    timeZone: 'America/New_York',
                    hour: 'numeric',
                    minute: '2-digit',
                  })} ET · RainViewer`
                : 'Loading…'}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
