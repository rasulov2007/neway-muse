/**
 * What NeWay AI "sees" when it drives the screen (owner, 2026-10-21): the page the person is on,
 * as a numbered list of the controls a person could press or fill, named the way a screen reader
 * would name them. Numbers (refs) are valid for one snapshot only; each element is tagged with
 * `data-ai-ref` so the runner can find it again. The chat itself is never part of it.
 */

export interface ScreenItem {
  ref: number;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  inDialog?: boolean;
  offscreen?: boolean;
  /** A native select's choices (first few). */
  options?: string[];
}

export interface ScreenSnapshot {
  route: string;
  title: string;
  dialogs: string[];
  headings: string[];
  alerts: string[];
  /** A short excerpt of what the screen says (the open dialog, else the page). */
  text: string;
  items: ScreenItem[];
  /** Controls left out by the cap. */
  more: number;
}

export const REF_ATTR = 'data-ai-ref';
export const MAX_ITEMS = 150;
/** Never read or touched: the chat panel, the run dock, the cursor overlay. */
export const EXCLUDED = '[data-ai-chat], [data-ai-overlay]';

const CANDIDATES = [
  'a[href]',
  'button',
  'input:not([type="hidden"])',
  'select',
  'textarea',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="combobox"]',
  '[contenteditable="true"]',
].join(', ');

const DIALOGS = '[role="dialog"], [role="alertdialog"], dialog[open]';

/** Part of NeWay AI itself: the chat, its dock, its cursor, or a panel (the chat drawer) that holds the chat. */
export function isExcluded(el: Element): boolean {
  if (el.closest(EXCLUDED)) return true;
  const dialog = el.closest(DIALOGS);
  return Boolean(dialog?.querySelector('[data-ai-chat]'));
}

/** The chat drawer is still on screen (open, or closing). */
export function chatPanelOpen(doc: Document = document): boolean {
  return Array.from(doc.querySelectorAll(DIALOGS)).some((d) => d.querySelector('[data-ai-chat]'));
}

let refs = new Map<number, HTMLElement>();

/** The element a ref of the latest snapshot named, if it is still on the page. */
export function elementFor(ref: number): HTMLElement | null {
  const el = refs.get(ref);
  return el && el.isConnected ? el : null;
}

export const clean = (s: string | null | undefined, max = 80): string => {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/** True in a real browser; jsdom has no layout, so sizes say nothing there. */
function hasLayout(doc: Document): boolean {
  return doc.documentElement.getBoundingClientRect().width > 0;
}

export function isShown(el: Element): boolean {
  if (el.closest('[hidden], [aria-hidden="true"], [inert]')) return false;
  const view = el.ownerDocument.defaultView;
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === 'function' && hasLayout(el.ownerDocument)) {
    if (!check.call(el, { visibilityProperty: true, checkVisibilityCSS: true })) return false;
  } else if (view) {
    for (let n: Element | null = el; n; n = n.parentElement) {
      const s = view.getComputedStyle(n);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
  }
  if (hasLayout(el.ownerDocument)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
  }
  return true;
}

const isField = (el: Element): el is HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement =>
  el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';

function byId(doc: Document, id: string): HTMLElement | null {
  return doc.getElementById(id);
}

function labelFor(el: HTMLElement): string {
  const doc = el.ownerDocument;
  if (el.id) {
    for (const l of Array.from(doc.getElementsByTagName('label'))) {
      if (l.htmlFor === el.id) {
        const t = clean(l.textContent);
        if (t) return t;
      }
    }
  }
  const wrap = el.closest('label');
  if (wrap) {
    const t = clean(wrap.textContent);
    if (t) return t;
  }
  return '';
}

/** The name a person would read: aria-label, aria-labelledby, its label, its words, placeholder, title. */
export function accessibleName(el: HTMLElement): string {
  const doc = el.ownerDocument;
  const aria = clean(el.getAttribute('aria-label'));
  if (aria) return aria;
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = clean(by.split(/\s+/).map((id) => byId(doc, id)?.textContent ?? '').join(' '));
    if (t) return t;
  }
  if (isField(el)) {
    const l = labelFor(el);
    if (l) return l;
    const ph = clean(el.getAttribute('placeholder'));
    if (ph) return ph;
    const title = clean(el.getAttribute('title'));
    if (title) return title;
    return clean(el.getAttribute('name'));
  }
  const words = clean(el.textContent);
  if (words) return words;
  const fromLabel = labelFor(el);
  if (fromLabel) return fromLabel;
  const title = clean(el.getAttribute('title'));
  if (title) return title;
  const img = el.querySelector('img[alt], svg title');
  return clean(img?.getAttribute('alt') ?? img?.textContent);
}

export function roleOf(el: HTMLElement): string {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  switch (el.tagName) {
    case 'A':
      return 'link';
    case 'BUTTON':
    case 'SUMMARY':
      return 'button';
    case 'SELECT':
      return 'select';
    case 'TEXTAREA':
      return 'textbox';
    case 'INPUT': {
      const type = (el as HTMLInputElement).type;
      if (type === 'checkbox' || type === 'radio') return type;
      if (type === 'button' || type === 'submit' || type === 'reset') return 'button';
      if (type === 'file') return 'file';
      if (type === 'date' || type === 'time' || type === 'datetime-local' || type === 'month' || type === 'week') return type;
      return 'textbox';
    }
    default:
      return el.isContentEditable ? 'textbox' : 'button';
  }
}

export function isDisabled(el: HTMLElement): boolean {
  if ((el as HTMLButtonElement).disabled) return true;
  if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('data-disabled')) return true;
  return Boolean(el.closest('fieldset[disabled]'));
}

function valueOf(el: HTMLElement, role: string): Pick<ScreenItem, 'value' | 'checked' | 'options'> {
  if (el.tagName === 'SELECT') {
    const s = el as HTMLSelectElement;
    return { value: clean(s.selectedOptions[0]?.textContent), options: Array.from(s.options).slice(0, 15).map((o) => clean(o.textContent, 40)) };
  }
  if (el.tagName === 'INPUT') {
    const i = el as HTMLInputElement;
    if (i.type === 'checkbox' || i.type === 'radio') return { checked: i.checked };
    if (i.type === 'file') return {};
    if (i.type === 'password') return i.value ? { value: '••••' } : {};
    return i.value ? { value: clean(i.value) } : {};
  }
  if (el.tagName === 'TEXTAREA') {
    const v = (el as HTMLTextAreaElement).value;
    return v ? { value: clean(v) } : {};
  }
  const aria = el.getAttribute('aria-checked') ?? (role === 'tab' ? el.getAttribute('aria-selected') : null);
  if (aria === 'true' || aria === 'false') return { checked: aria === 'true' };
  if (role === 'combobox') {
    const shown = clean(el.textContent);
    return shown ? { value: shown } : {};
  }
  return {};
}

/** A row action says which row it is on ("Open — row: L-100005 · Acme"). */
function rowContext(el: HTMLElement, name: string): string {
  const row = el.closest('tr');
  if (!row) return '';
  const cells = Array.from(row.querySelectorAll('td'))
    .filter((c) => !c.contains(el))
    .map((c) => clean(c.textContent, 30))
    .filter(Boolean)
    .slice(0, 3)
    .join(' · ');
  if (!cells || cells.startsWith(name)) return '';
  return clean(cells, 60);
}

function dialogName(d: Element): string {
  const by = d.getAttribute('aria-labelledby');
  const doc = d.ownerDocument;
  const t = clean(d.getAttribute('aria-label')) || (by ? clean(by.split(/\s+/).map((id) => byId(doc, id)?.textContent ?? '').join(' ')) : '');
  return t || clean(d.querySelector('h1, h2, h3, [role="heading"]')?.textContent) || 'Dialog';
}

function visibleText(el: HTMLElement): string {
  const inner = (el as HTMLElement & { innerText?: string }).innerText;
  return typeof inner === 'string' && hasLayout(el.ownerDocument) ? inner : (el.textContent ?? '');
}

function outsideViewport(el: Element): boolean {
  if (!hasLayout(el.ownerDocument)) return false;
  const r = el.getBoundingClientRect();
  const view = el.ownerDocument.defaultView!;
  return r.bottom < 0 || r.top > view.innerHeight || r.right < 0 || r.left > view.innerWidth;
}

/** Reads the screen and numbers its controls. Dialogs first, then what is in view, then the rest. */
export function buildSnapshot(doc: Document = document, max = MAX_ITEMS): ScreenSnapshot {
  for (const old of Array.from(doc.querySelectorAll(`[${REF_ATTR}]`))) old.removeAttribute(REF_ATTR);
  refs = new Map();

  const dialogs = Array.from(doc.querySelectorAll(DIALOGS)).filter((d) => !isExcluded(d) && isShown(d));
  const top = dialogs.at(-1) ?? null;
  const all = Array.from(doc.querySelectorAll<HTMLElement>(CANDIDATES)).filter((el) => !isExcluded(el) && isShown(el));
  // An element matching several selectors is listed once.
  const seen = new Set<HTMLElement>();
  const rank = (el: HTMLElement) => (top && top.contains(el) ? 0 : el.closest(DIALOGS) ? 1 : outsideViewport(el) ? 3 : 2);
  const ordered = all.map((el, i) => ({ el, i, r: rank(el) })).sort((a, b) => a.r - b.r || a.i - b.i);

  const items: ScreenItem[] = [];
  let more = 0;
  for (const { el } of ordered) {
    if (seen.has(el)) continue;
    seen.add(el);
    const role = roleOf(el);
    let name = accessibleName(el);
    if (!name && role !== 'textbox') continue;
    const ctx = rowContext(el, name);
    if (ctx) name = `${name} — row: ${ctx}`;
    if (items.length >= max) {
      more++;
      continue;
    }
    const ref = items.length + 1;
    el.setAttribute(REF_ATTR, String(ref));
    refs.set(ref, el);
    const item: ScreenItem = { ref, role, name: name || '(no label)', ...valueOf(el, role) };
    if (isDisabled(el)) item.disabled = true;
    if (el.closest(DIALOGS)) item.inDialog = true;
    if (outsideViewport(el)) item.offscreen = true;
    items.push(item);
  }

  const headings = uniq(
    Array.from(doc.querySelectorAll('h1, h2, h3, [role="heading"]'))
      .filter((h) => !isExcluded(h) && isShown(h))
      .map((h) => clean(h.textContent, 60))
      .filter(Boolean),
  ).slice(0, 12);
  const alerts = uniq(
    Array.from(doc.querySelectorAll('[role="alert"], [role="status"], [aria-live="assertive"], [aria-live="polite"]'))
      .filter((a) => !isExcluded(a) && isShown(a))
      .map((a) => clean(a.textContent, 140))
      .filter(Boolean),
  ).slice(0, 5);
  const textRoot = (top as HTMLElement | null) ?? doc.querySelector<HTMLElement>('main') ?? doc.body;
  const view = doc.defaultView;
  return {
    route: view ? `${view.location.pathname}${view.location.search}` : '',
    title: clean(doc.title, 100),
    dialogs: dialogs.map(dialogName),
    headings,
    alerts,
    text: clean(visibleText(textRoot), 1500),
    items,
    more,
  };
}

function uniq(list: string[]): string[] {
  return Array.from(new Set(list));
}

/** The snapshot as the model reads it: short lines, one per control. */
export function formatSnapshot(s: ScreenSnapshot): string {
  const lines = [`Page: ${s.route}${s.title ? ` — "${s.title}"` : ''}`];
  if (s.dialogs.length) lines.push(`Dialogs open: ${s.dialogs.map((d) => `"${d}"`).join(', ')} (its controls are listed first)`);
  if (s.headings.length) lines.push(`Headings: ${s.headings.join(' | ')}`);
  if (s.alerts.length) lines.push(`Alerts: ${s.alerts.join(' | ')}`);
  if (s.text) lines.push(`Text: ${s.text}`);
  lines.push('Elements:');
  for (const i of s.items) {
    const bits = [`[${i.ref}] ${i.role} "${i.name}"`];
    if (i.value !== undefined) bits.push(`= "${i.value}"`);
    if (i.checked !== undefined) bits.push(i.checked ? 'checked' : 'not checked');
    if (i.options?.length) bits.push(`options: ${i.options.join(' / ')}`);
    if (i.disabled) bits.push('(disabled)');
    if (i.inDialog) bits.push('(in dialog)');
    if (i.offscreen) bits.push('(off screen)');
    lines.push(bits.join(' '));
  }
  if (!s.items.length) lines.push('(no controls visible)');
  if (s.more) lines.push(`…and ${s.more} more not listed (scroll, filter or open the section to see them)`);
  return lines.join('\n');
}
