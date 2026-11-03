/**
 * How NeWay AI presses and types like a person: real pointer and mouse events at the element's
 * centre (Radix menus open on pointerdown, tabs on mousedown, buttons on click), and the native
 * value setter plus input/change events so React-controlled fields see the new value.
 */

type Field = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

/** Sets a field's value the way the browser does, past React's value tracker. */
export function setNativeValue(el: Field, value: string): void {
  const win = el.ownerDocument.defaultView ?? window;
  const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? win.HTMLSelectElement.prototype : win.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
}

export function fire(el: Element, type: 'input' | 'change'): void {
  el.dispatchEvent(new Event(type, { bubbles: true }));
}

export function centreOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

const focusable = (el: HTMLElement) => typeof el.focus === 'function' && (el.tabIndex >= 0 || /^(INPUT|SELECT|TEXTAREA|BUTTON|A)$/.test(el.tagName));

/** The full press: pointer and mouse down/up, focus, then click. */
export function press(el: HTMLElement): void {
  const win = el.ownerDocument.defaultView ?? window;
  const { x, y } = centreOf(el);
  const base = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, button: 0 };
  const Pointer = (win as typeof window).PointerEvent;
  const pointer = (type: string, extra: Record<string, unknown> = {}) => {
    const init = { ...base, pointerId: 1, pointerType: 'mouse', isPrimary: true, ...extra };
    return el.dispatchEvent(Pointer ? new Pointer(type, init) : Object.assign(new win.MouseEvent(type, init), { pointerType: 'mouse', pointerId: 1 }));
  };
  pointer('pointerover');
  el.dispatchEvent(new win.MouseEvent('mouseover', base));
  pointer('pointermove');
  const downOk = pointer('pointerdown', { buttons: 1 });
  const mouseOk = downOk && el.dispatchEvent(new win.MouseEvent('mousedown', { ...base, buttons: 1 }));
  if (mouseOk && el.isConnected && focusable(el)) el.focus({ preventScroll: true });
  pointer('pointerup');
  el.dispatchEvent(new win.MouseEvent('mouseup', base));
  if (el.isConnected) el.click();
}

/** A key press on an element: keydown then keyup. Returns false when a handler prevented it. */
export function key(el: Element, k: string): boolean {
  const win = el.ownerDocument.defaultView ?? window;
  const init = { key: k, code: k === 'Enter' ? 'Enter' : k === 'Escape' ? 'Escape' : k === 'Tab' ? 'Tab' : `Key${k.toUpperCase()}`, bubbles: true, cancelable: true, composed: true };
  const ok = el.dispatchEvent(new win.KeyboardEvent('keydown', init));
  el.dispatchEvent(new win.KeyboardEvent('keyup', init));
  return ok;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Stopped', 'AbortError'));
    if (ms <= 0) return resolve();
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(new DOMException('Stopped', 'AbortError'))), { once: true });
  });
export { sleep };

/** Types into a field character by character; date-like fields take the whole value at once. */
export async function typeInto(el: HTMLInputElement | HTMLTextAreaElement, text: string, opts: { clear?: boolean; delay?: number; signal?: AbortSignal } = {}): Promise<void> {
  const { clear = true, delay = 18, signal } = opts;
  if (el.ownerDocument.activeElement !== el) el.focus({ preventScroll: true });
  if (clear && el.value) {
    setNativeValue(el, '');
    fire(el, 'input');
  }
  const whole = el.tagName === 'INPUT' && /^(date|time|datetime-local|month|week|color|range)$/.test((el as HTMLInputElement).type);
  if (whole) {
    setNativeValue(el, text);
    fire(el, 'input');
  } else {
    for (const ch of Array.from(text)) {
      if (!key(el, ch)) continue;
      // Read the field each time: a mask may have reformatted what was typed so far.
      setNativeValue(el, el.value + ch);
      fire(el, 'input');
      await sleep(delay, signal);
    }
  }
  fire(el, 'change');
}
