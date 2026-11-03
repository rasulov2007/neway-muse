import { centreOf, fire, key, press, setNativeValue, sleep, typeInto } from './dom';
import { cursorStore, driveConfig } from './cursor';
import { riskyVerb } from './risk';
import { EXCLUDED, accessibleName, isExcluded, buildSnapshot, clean, elementFor, formatSnapshot, isDisabled, isShown, roleOf } from './snapshot';

/**
 * Runs one screen tool in the person's browser, the way a person would: scroll the control into
 * view, glide the cursor to it, outline it, press or type. Each answer is one short line (the
 * person's log shows it too) and a fresh snapshot, so the model sees what its step did.
 */

export interface RunnerHost {
  /** Opens a web route with the app's router. */
  navigate(to: string): Promise<void>;
  /** Asks the person before a risky press; resolves true on Allow. */
  confirm(ask: { verb: string; name: string; where: string }): Promise<boolean>;
  dryRun: boolean;
  signal: AbortSignal;
  /** Resolves once the person lets the run continue (immediately when nobody took over). */
  waitIfPaused(): Promise<void>;
  /** The live step line in the chat. */
  step(line: string): void;
}

export interface ToolAnswer {
  content: string;
  isError: boolean;
}

export const SNAPSHOT_MARK = '\n--- screen ---\n';
const LOADING = 'Loading…';
const q = (s: string) => `‘${s}’`;

/** What the screen says, without the chat's own words. */
function screenText(doc: Document): string {
  const layout = doc.documentElement.getBoundingClientRect().width > 0;
  const read = (el: HTMLElement) => (layout && typeof el.innerText === 'string' ? el.innerText : (el.textContent ?? ''));
  let text = read(doc.body);
  for (const el of Array.from(doc.querySelectorAll<HTMLElement>(EXCLUDED))) {
    const own = read(el);
    if (own) text = text.replace(own, '');
  }
  return text;
}

/** Waits until the page is not saying "Loading…" (and has the text, when asked), up to `max` ms. */
export async function settle(signal: AbortSignal, max = 3000, forText?: string): Promise<boolean> {
  const until = Date.now() + max;
  if (driveConfig.animate) await sleep(250, signal);
  for (;;) {
    const text = screenText(document);
    const ready = !text.includes(LOADING) && (!forText || text.toLowerCase().includes(forText.toLowerCase()));
    if (ready) return true;
    if (Date.now() >= until) return false;
    await sleep(150, signal);
  }
}

function snapshotText(): string {
  return SNAPSHOT_MARK + formatSnapshot(buildSnapshot(document));
}

const answer = (line: string, isError = false): ToolAnswer => ({ content: line + snapshotText(), isError });
const fail = (line: string): ToolAnswer => answer(line, true);

function target(input: Record<string, unknown>): HTMLElement | string {
  const ref = Number(input.ref);
  if (!Number.isInteger(ref) || ref < 1) return 'Give the [number] of an element from the latest snapshot.';
  const el = elementFor(ref);
  if (!el) return `Element [${ref}] is gone from the screen. Read the screen again.`;
  if (isExcluded(el)) return 'NeWay AI does not press anything inside its own chat.';
  return el;
}

/** Where a control is, for the confirmation: the open dialog, else the row, else the page heading. */
function whereOf(el: HTMLElement): string {
  const dialog = el.closest('[role="dialog"], [role="alertdialog"]');
  const heading = (root: ParentNode | null) => clean(root?.querySelector('h1, h2, h3, [role="heading"]')?.textContent, 60);
  if (dialog) return heading(dialog) || clean(dialog.getAttribute('aria-label'), 60) || 'the open dialog';
  const row = el.closest('tr');
  if (row) return clean(Array.from(row.querySelectorAll('td')).map((c) => clean(c.textContent, 30)).filter(Boolean).slice(0, 2).join(' · '), 60);
  return heading(document.querySelector('main')) || clean(document.title, 60) || 'this page';
}

/** Scrolls the control into view and glides the cursor onto it. */
async function reach(el: HTMLElement, host: RunnerHost): Promise<void> {
  el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: driveConfig.animate ? 'smooth' : 'auto' });
  if (driveConfig.animate) await sleep(220, host.signal);
  const { x, y } = centreOf(el);
  const r = el.getBoundingClientRect();
  cursorStore.ring({ left: r.left, top: r.top, width: r.width, height: r.height });
  await cursorStore.moveTo(x, y, host.signal);
}

/** The gate before a press: Dry run says what it would do, a risky press asks the person. */
async function gate(name: string, role: string, el: HTMLElement, host: RunnerHost): Promise<ToolAnswer | null> {
  const verb = riskyVerb(name, role);
  if (!verb) return null;
  if (host.dryRun) return answer(`dry run: would press ${q(name)} (not pressed - Dry run is on).`);
  const allowed = await host.confirm({ verb, name, where: whereOf(el) });
  if (!allowed) return fail(`The person did not allow pressing ${q(name)}. Do not try again; ask what to do.`);
  return null;
}

async function clickEl(el: HTMLElement, host: RunnerHost): Promise<void> {
  await reach(el, host);
  await host.waitIfPaused();
  await cursorStore.ripple(host.signal);
  press(el);
  cursorStore.ring(null);
}

function visibleOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).filter((o) => !isExcluded(o) && isShown(o));
}

function pick<T>(list: T[], label: (t: T) => string, want: string): T | undefined {
  const w = clean(want, 200).toLowerCase();
  const l = (t: T) => clean(label(t), 200).toLowerCase();
  return list.find((t) => l(t) === w) ?? list.find((t) => l(t).startsWith(w)) ?? list.find((t) => l(t).includes(w));
}

async function waitFor<T>(get: () => T | null | undefined, signal: AbortSignal, ms = 2000): Promise<T | null> {
  const until = Date.now() + ms;
  for (;;) {
    const v = get();
    if (v) return v;
    if (Date.now() >= until) return null;
    await sleep(60, signal);
  }
}

function nextTabbable(from: Element | null): HTMLElement | null {
  const all = Array.from(document.querySelectorAll<HTMLElement>('a[href], button, input, select, textarea, [tabindex]')).filter(
    (el) => el.tabIndex >= 0 && !isDisabled(el) && !isExcluded(el) && isShown(el),
  );
  if (!all.length) return null;
  const at = from ? all.indexOf(from as HTMLElement) : -1;
  return all[(at + 1) % all.length] ?? null;
}

export async function runScreenTool(call: { name: string; input: Record<string, unknown> }, host: RunnerHost): Promise<ToolAnswer> {
  const input = call.input ?? {};
  switch (call.name) {
    case 'screen_read':
      host.step('Reading the screen…');
      return { content: `Screen read.${snapshotText()}`, isError: false };

    case 'screen_click': {
      const el = target(input);
      if (typeof el === 'string') return fail(el);
      const name = accessibleName(el) || 'the control';
      const role = roleOf(el);
      if (isDisabled(el)) return fail(`${q(name)} is disabled; it cannot be pressed now. Read the screen to see what it needs first.`);
      const gated = await gate(name, role, el, host);
      if (gated) return gated;
      host.step(`Clicking ${q(name)}…`);
      await clickEl(el, host);
      await settle(host.signal);
      return answer(`Clicked ${q(name)}.`);
    }

    case 'screen_type': {
      const el = target(input);
      if (typeof el === 'string') return fail(el);
      const name = accessibleName(el) || 'the field';
      const text = typeof input.text === 'string' ? input.text : '';
      const isText = (el.tagName === 'INPUT' && !/^(checkbox|radio|file|button|submit|reset|hidden)$/.test((el as HTMLInputElement).type)) || el.tagName === 'TEXTAREA';
      if (!isText) return fail(`${q(name)} is not a text field. Use screen_click or screen_select for it.`);
      const field = el as HTMLInputElement | HTMLTextAreaElement;
      if (field.disabled || field.readOnly) return fail(`${q(name)} cannot be edited right now (it is ${field.disabled ? 'disabled' : 'read-only'}).`);
      host.step(`Typing into ${q(name)}…`);
      await reach(el, host);
      await host.waitIfPaused();
      await cursorStore.ripple(host.signal);
      press(el);
      await typeInto(field, text, { clear: input.clear !== false, delay: driveConfig.animate ? 18 : 0, signal: host.signal });
      cursorStore.ring(null);
      const secret = el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'password';
      return answer(`Typed ${secret ? 'the password' : `“${clean(text, 60)}”`} into ${q(name)}.`);
    }

    case 'screen_select': {
      const el = target(input);
      if (typeof el === 'string') return fail(el);
      const name = accessibleName(el) || 'the field';
      const want = typeof input.option === 'string' ? input.option : '';
      if (!want) return fail('Say which option to choose.');
      if (isDisabled(el)) return fail(`${q(name)} is disabled.`);
      if (el.tagName === 'SELECT') {
        const s = el as HTMLSelectElement;
        const opt = pick(Array.from(s.options), (o) => o.textContent ?? '', want);
        if (!opt) return fail(`${q(name)} has no option ${q(want)}. Options: ${Array.from(s.options).map((o) => clean(o.textContent, 40)).join(' / ')}`);
        host.step(`Choosing ${q(clean(opt.textContent))} in ${q(name)}…`);
        await reach(el, host);
        await cursorStore.ripple(host.signal);
        s.focus();
        setNativeValue(s, opt.value);
        fire(s, 'input');
        fire(s, 'change');
        cursorStore.ring(null);
        return answer(`Chose ${q(clean(opt.textContent))} in ${q(name)}.`);
      }
      // A design-system select or combobox: open it, then press the option.
      host.step(`Opening ${q(name)}…`);
      await clickEl(el, host);
      const options = await waitFor(() => (visibleOptions().length ? visibleOptions() : null), host.signal);
      if (!options) return fail(`${q(name)} did not open a list of options.`);
      const opt = pick(options, (o) => accessibleName(o), want);
      if (!opt) {
        const shown = options.map((o) => accessibleName(o)).slice(0, 25).join(' / ');
        key(document.activeElement ?? document.body, 'Escape');
        return fail(`${q(name)} has no option ${q(want)}. Options: ${shown}`);
      }
      const label = accessibleName(opt);
      host.step(`Choosing ${q(label)}…`);
      await clickEl(opt, host);
      // Radix ignores a press that lands where the list opened; the keyboard always works.
      if (opt.isConnected && isShown(opt)) {
        opt.focus();
        key(opt, 'Enter');
      }
      await settle(host.signal, 1500);
      return answer(`Chose ${q(label)} in ${q(name)}.`);
    }

    case 'screen_press': {
      const k = input.key === 'Enter' || input.key === 'Escape' || input.key === 'Tab' ? input.key : null;
      if (!k) return fail('Only Enter, Escape and Tab can be pressed.');
      const active = (document.activeElement && !isExcluded(document.activeElement) ? document.activeElement : document.body) as HTMLElement;
      host.step(`Pressing ${k}…`);
      await host.waitIfPaused();
      if (k === 'Tab') {
        const next = nextTabbable(active === document.body ? null : active);
        next?.focus();
        return answer(next ? `Moved to ${q(accessibleName(next) || roleOf(next))}.` : 'Nothing to move to.');
      }
      const form = k === 'Enter' && active.tagName === 'INPUT' ? (active as HTMLInputElement).form : null;
      const submitter = form?.querySelector<HTMLElement>('button[type="submit"], button:not([type]), input[type="submit"]') ?? null;
      if (submitter) {
        const gated = await gate(accessibleName(submitter), 'button', submitter, host);
        if (gated) return gated;
      }
      const notPrevented = key(active, k);
      if (k === 'Enter' && notPrevented && form) form.requestSubmit(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : undefined);
      await settle(host.signal);
      return answer(`Pressed ${k}.`);
    }

    case 'screen_open': {
      const to = typeof input.to === 'string' ? input.to.trim() : '';
      if (!/^\/(?!\/)/.test(to) || /^\/api\//.test(to)) return fail('Give a TMS web route that starts with /, e.g. /accounting/invoices.');
      host.step(`Opening ${to}…`);
      await host.waitIfPaused();
      await host.navigate(to);
      const ready = await settle(host.signal, 8000);
      return answer(`Opened ${to}${ready ? '' : ' (still loading)'}.`);
    }

    case 'screen_scroll': {
      const down = input.direction !== 'up';
      let box: HTMLElement | null = null;
      if (input.ref !== undefined) {
        const el = target(input);
        if (typeof el === 'string') return fail(el);
        for (let n: HTMLElement | null = el; n; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (n.scrollHeight > n.clientHeight + 4 && /(auto|scroll)/.test(s.overflowY)) {
            box = n;
            break;
          }
        }
        if (box) await reach(box, host);
      }
      host.step(`Scrolling ${down ? 'down' : 'up'}…`);
      const amount = Math.round((box ? box.clientHeight : window.innerHeight) * 0.7) * (down ? 1 : -1);
      if (box) box.scrollBy({ top: amount, behavior: driveConfig.animate ? 'smooth' : 'auto' });
      else window.scrollBy({ top: amount, behavior: driveConfig.animate ? 'smooth' : 'auto' });
      if (driveConfig.animate) await sleep(450, host.signal);
      cursorStore.ring(null);
      return answer(`Scrolled ${down ? 'down' : 'up'}.`);
    }

    case 'screen_wait': {
      const ms = Math.min(10_000, Math.max(0, Number(input.ms) || 10_000));
      const forText = typeof input.forText === 'string' && input.forText.trim() ? input.forText.trim() : undefined;
      host.step(forText ? `Waiting for ${q(forText)}…` : 'Waiting for the page…');
      const ok = await settle(host.signal, ms, forText);
      return answer(ok ? (forText ? `${q(forText)} is on the screen.` : 'The page has loaded.') : `Still not ready after ${Math.round(ms / 1000)} s${forText ? `: ${q(forText)} did not appear` : ''}.`);
    }

    default:
      return { content: `Unknown screen tool ${call.name}.`, isError: true };
  }
}
