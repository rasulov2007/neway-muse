/**
 * The legal wording comes from the company's approved template rows. It is rendered as HTML, but
 * only after this allow-list: the tags the source documents use, and no attribute except class,
 * rowspan and colspan. Anything else is dropped (script-like elements with their content; any
 * other element is unwrapped so its text stays).
 */

const ALLOWED = new Set(['p', 'ul', 'ol', 'li', 'b', 'i', 'br', 'h4', 'table', 'tr', 'th', 'td', 'strong', 'em', 'tbody', 'thead']);
const DROP_WITH_CONTENT = new Set(['script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'svg', 'math', 'textarea', 'select', 'button', 'form', 'link', 'meta', 'title', 'head']);
const ATTRS = new Set(['class', 'rowspan', 'colspan']);

function cleanAttr(name: string, value: string): string | null {
  if (name === 'class') {
    const v = value.replace(/[^A-Za-z0-9_ -]/g, '').trim();
    return v ? v : null;
  }
  return /^\d{1,2}$/.test(value.trim()) ? value.trim() : null;
}

function walk(src: Node, out: Node, doc: Document): void {
  for (const node of [...src.childNodes]) {
    if (node.nodeType === 3) {
      out.appendChild(doc.createTextNode(node.textContent ?? ''));
      continue;
    }
    if (node.nodeType !== 1) continue;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) continue;
    if (!ALLOWED.has(tag)) {
      walk(el, out, doc);
      continue;
    }
    const copy = doc.createElement(tag);
    for (const a of [...el.attributes]) {
      const n = a.name.toLowerCase();
      if (!ATTRS.has(n)) continue;
      const v = cleanAttr(n, a.value);
      if (v !== null) copy.setAttribute(n, v);
    }
    walk(el, copy, doc);
    out.appendChild(copy);
  }
}

export function sanitizeLegalHtml(html: unknown): string {
  if (typeof html !== 'string' || html === '') return '';
  const parsed = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html');
  const doc = document.implementation.createHTMLDocument('');
  const box = doc.createElement('div');
  walk(parsed.body, box, doc);
  return box.innerHTML;
}

/** Plain text for an HTML snippet (used where the wording is placed inside an attribute or a label list). */
export function legalText(html: unknown): string {
  if (typeof html !== 'string') return '';
  return new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html').body.textContent ?? '';
}

/** Escape a value before it is placed into template HTML (e.g. the employer name in the SPH sentence). */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
