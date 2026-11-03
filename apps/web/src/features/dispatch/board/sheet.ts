import type { DispatchStatus, StatusFamily } from '@neway/shared';
import './board-colors.css';

/**
 * What both boards share in look: the ten Sheets tints, the sheet's status colours, the grid
 * chrome (navy header, grey team band, white cells, blue-grey borders) and a few readings of
 * time. Every colour is a variable from `board-colors.css`; none is written here.
 */

/** The ten tints a cell can be painted with. 0 = none. Index = tint number. */
export const TINT_CLASS: Record<number, string> = {
  1: 'bg-(--bd-fill-1)',
  2: 'bg-(--bd-fill-2)',
  3: 'bg-(--bd-fill-3)',
  4: 'bg-(--bd-fill-4)',
  5: 'bg-(--bd-fill-5)',
  6: 'bg-(--bd-fill-6)',
  7: 'bg-(--bd-fill-7)',
  8: 'bg-(--bd-fill-8)',
  9: 'bg-(--bd-fill-9)',
  10: 'bg-(--bd-fill-10)',
};

export const TINT_LABEL: Record<number, string> = {
  0: 'No fill',
  1: 'Green',
  2: 'Amber',
  3: 'Red',
  4: 'Blue',
  5: 'Teal',
  6: 'Grey',
  7: 'Light grey',
  8: 'Purple',
  9: 'Light green',
  10: 'Light amber',
};

/** The status cell painted whole, the sheet's colours: word in bold on the colour. */
export const STATUS_CELL: Record<DispatchStatus, string> = {
  'RE-UPDATE': 'bg-(--bd-re-update) text-(--bd-re-update-text)',
  DISPATCHED: 'bg-(--bd-dispatched) text-(--bd-dispatched-text)',
  'AT PU': 'bg-(--bd-at-pu) text-(--bd-at-pu-text)',
  COVERED: 'bg-(--bd-covered) text-(--bd-covered-text)',
  RESERVED: 'bg-(--bd-reserved) text-(--bd-reserved-text)',
  'HOLD FOR LOAD': 'bg-(--bd-hold-for-load) text-(--bd-hold-for-load-text)',
  READY: 'bg-(--bd-ready) text-(--bd-ready-text)',
  ENROUTE: 'bg-(--bd-enroute) text-(--bd-enroute-text)',
  UNLOADING: 'bg-(--bd-unloading) text-(--bd-unloading-text)',
  'NO ANSWER': 'bg-(--bd-no-answer) text-(--bd-no-answer-text)',
  STOP: 'bg-(--bd-stop) text-(--bd-stop-text)',
  REST: 'bg-(--bd-rest) text-(--bd-rest-text)',
  'NEW DRIVER': 'bg-(--bd-new-driver) text-(--bd-new-driver-text)',
  HOME: 'bg-(--bd-home) text-(--bd-home-text)',
  VACATION: 'bg-(--bd-vacation) text-(--bd-vacation-text)',
  SHOP: 'bg-(--bd-shop) text-(--bd-shop-text)',
  INACTIVE: 'bg-(--bd-inactive) text-(--bd-inactive-text)',
};

/*
 * The Weekly Board paints a status word in an Amount cell with these same classes (owner,
 * 2026-10-01: "the same colours as the Daily Board"). One map for both boards - no weekly copy.
 */

/** A status word in the menu: its colour as a swatch beside it. */
export const STATUS_SWATCH: Record<DispatchStatus, string> = Object.fromEntries(
  Object.entries(STATUS_CELL).map(([k, v]) => [k, v.split(' ')[0]]),
) as Record<DispatchStatus, string>;

/** Kept for the report page and filters: the Porcelain family text colours. */
export const FAMILY_TEXT: Record<StatusFamily, string> = {
  moving: 'text-nw-moving-text',
  info: 'text-nw-moving-text',
  warning: 'text-nw-warning-text',
  done: 'text-nw-done-text',
  urgent: 'text-nw-urgent-text',
  neutral: 'text-nw-neutral-text',
};
export const FAMILY_CELL: Record<StatusFamily, string> = {
  moving: 'bg-nw-moving-bg text-nw-moving-text',
  info: 'bg-nw-moving-bg text-nw-moving-text',
  warning: 'bg-nw-warning-bg text-nw-warning-text',
  done: 'bg-nw-done-bg text-nw-done-text',
  urgent: 'bg-nw-urgent-bg text-nw-urgent-text',
  neutral: 'bg-nw-neutral-bg text-nw-neutral-text',
};

const B = 'border-(--bd-border)';
/**
 * Two rules, as the sheet has: a fine one between cells and the firm `B` for
 * structure - the frame, the header's foot, the grand total, the team band and
 * the line that closes a driver's block. That is what makes a spreadsheet
 * readable at a glance instead of a uniform mesh.
 */
const G = 'border-(--bd-grid)';

/** The grid chrome. */
export const GRID = {
  /** The scroll box around a board. */
  frame: `overflow-auto rounded-md border ${B} bg-nw-panel outline-none focus:outline-none focus-visible:outline-none [&:focus-visible]:outline-none`,
  /*
   * Both boards wear the same header: the teal of the Teams button, white labels. One colour for
   * "this is the board's own chrome" - the owner asked for it on every board, so it is one class
   * pair here rather than a navy on one screen and a white one on the next.
   */
  headNavy: `h-10 border-r border-b ${B} bg-nw-accent px-2 text-center align-middle text-[12px] font-bold whitespace-nowrap text-nw-on-accent uppercase`,
  /*
   * The Weekly Board's header (owner's mockup, 2026-10-01): the panel colour with the labels in
   * teal - white in light mode, the panel in dark. Lines are drawn by board-colors.css as inset
   * shadows, not borders, so nothing scrolls through the sticky rows. Only the Weekly Board wears
   * it; the Daily Board and the reports keep `headNavy`.
   */
  headTeal: 'h-[60px] bg-nw-panel px-2 text-center align-middle text-[12.5px] font-bold text-nw-accent',
  /*
   * The Weekly Board's grand total: the one row with its own background, the dark band of the
   * mockup, white figures. Opaque on every cell so nothing shows through while it is pinned.
   */
  wkGrandCell: 'tabular h-[46px] bg-(--bd-grand) px-2 text-center align-middle text-[13px] font-bold whitespace-nowrap text-(--bd-navy-text)',
  /** The grand-total row. */
  grand: 'bg-(--bd-grand) text-(--bd-navy-text)',
  /*
   * The fill sits on the cell, not only on the row: a row's background paints
   * under a sticky cell, so with it on the <tr> alone the rows scrolling past
   * showed through the grand total. On the cell it covers.
   */
  grandCell: `tabular h-[34px] border-r border-b ${B} bg-(--bd-grand) px-3 text-center align-middle text-[13px] font-bold whitespace-nowrap`,
  /** The team band. */
  band: 'bg-(--bd-band)',
  /**
   * The weekly sheet's dispatcher row — the divider the sheet paints with
   * `=AND($A3<>"",$B3="")`: #cfe2f3, black, bold, right across the row.
   */
  wkDivider: 'bg-(--bd-wk-divider) font-bold text-(--bd-wk-divider-text)',
  /** The weekly team band: the light band of the sheet, bold, its own totals across the week. */
  wkBand: 'bg-(--bd-band) font-bold text-nw-text',
  bandCell: `h-[30px] border-r ${G} border-b ${B} px-2 text-center align-middle text-[13px] font-semibold whitespace-nowrap text-nw-text`,
  /** An ordinary body cell: white, centred, thin border. */
  cell: `h-[26px] border-r border-b ${G} bg-nw-panel px-1.5 text-center align-middle text-[13px] font-normal text-nw-text`,
  /** A read-only body cell. */
  ro: `h-[26px] border-r border-b ${G} bg-nw-panel px-2 text-center align-middle text-[13px] font-normal text-nw-text-2`,
  /** A summary cell on the weekly board: the light grey of the sheet. */
  summary: `tabular border-r border-b ${G} bg-(--bd-summary) px-3 text-center align-middle text-[13px] font-semibold whitespace-nowrap text-nw-text`,
  /** The sheet's chips: blue unit, grey tag. */
  chipBlue: 'inline-flex h-5 items-center rounded px-1.5 text-[11.5px] font-bold bg-(--bd-blue-bg) text-(--bd-blue)',
  chipGrey: 'inline-flex h-5 items-center rounded px-1.5 text-[11.5px] font-semibold bg-(--bd-chip) text-(--bd-chip-text)',
  pillBlue: 'inline-flex h-6 items-center rounded-full border border-(--bd-blue) px-2.5 text-[12.5px] font-bold text-(--bd-blue)',
  pillGrey: 'inline-flex h-6 items-center rounded-full border border-(--bd-border) px-2.5 text-[12.5px] font-semibold text-nw-text-2',
  pillAmber: 'inline-flex h-6 items-center rounded-full border border-(--bd-amber) px-2.5 text-[12.5px] font-bold text-(--bd-amber-text)',
  badgeAmber: 'inline-flex h-4 items-center rounded px-1 text-[9.5px] font-extrabold tracking-wide bg-(--bd-amber-bg) text-(--bd-amber-text) uppercase',
  badgeRed: 'inline-flex h-4 items-center rounded px-1 text-[9.5px] font-extrabold tracking-wide bg-(--bd-red-bg) text-(--bd-red-text) uppercase',
  linkRed: 'text-[12px] font-semibold text-(--bd-red) hover:underline',
  green: 'text-(--bd-green)',
  red: 'text-(--bd-red)',
} as const;

/** "1d 18h", "2h 33m", "37m" - how long a row has held its status. */
export function sinceLabel(iso: string | null, nowIso: string): string {
  if (!iso) return '';
  const ms = Date.parse(nowIso) - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return '';
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const mins = minutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  return `${mins}m`;
}

/** Days red, hours amber, minutes grey (Board T). */
export function sinceTone(iso: string | null, nowIso: string): 'urgent' | 'warning' | 'neutral' {
  if (!iso) return 'neutral';
  const ms = Date.parse(nowIso) - Date.parse(iso);
  if (ms >= 86_400_000) return 'urgent';
  if (ms >= 3_600_000) return 'warning';
  return 'neutral';
}

/** `555-010-3857 // 555-010-2741` → two dial links with the separator kept. */
export function phoneParts(text: string): { kind: 'tel' | 'text' | 'sep'; value: string }[] {
  // A driver may have two numbers: split on //, /, a comma, a semicolon, or a space that starts
  // a second full ten-digit number ("555-010-9927 555-010-0983").
  const pieces = text
    .split(/\s*(?:\/\/?|,|;)\s*|\s+(?=\+?1?[\s.-]?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b)/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const out: { kind: 'tel' | 'text' | 'sep'; value: string }[] = [];
  pieces.forEach((p, i) => {
    if (i > 0) out.push({ kind: 'sep', value: ' / ' });
    out.push(/^[+\d(][\d\s().-]{6,}$/.test(p) ? { kind: 'tel', value: p } : { kind: 'text', value: p });
  });
  return out;
}

export function money(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/** Whole dollars, the way the sheet showed amounts: $3,500. Cents only when there are any. */
export function moneyCell(n: number): string {
  return Number.isInteger(n) ? n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }) : money(n);
}

export function cents(c: number): string {
  return money(c / 100);
}

export function moneyShort(n: number): string {
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
}

export function pct(n: number): string {
  return `${n.toFixed(2)}%`;
}
