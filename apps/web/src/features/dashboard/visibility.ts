/**
 * What the principal may see (docs/DASHBOARD.md §10). Masking happens on the server; widgets
 * only use this to render "••••••" placeholders consistently, never to hide client-side data.
 */
export interface Visibility {
  /** `dashboard.view_financial`: gross, cost, profit, RPM/CPM/PPM, margin, per-truck money. */
  financial: boolean;
}

export const FULL_VISIBILITY: Visibility = { financial: true };

/** Derives the visibility from a response's `masked` flag. */
export function visibilityOf(masked: boolean): Visibility {
  return { financial: !masked };
}
