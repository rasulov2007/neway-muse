/**
 * Legal template text is stored as a small HTML fragment (paragraphs, bold, lists, tables). It is
 * shown read-only; before it reaches the page every element outside a short allow-list is reduced
 * to its text and every attribute is dropped, so a template can never carry a script, a link, a
 * style or an event handler into the TMS.
 */
const ALLOWED = new Set(['P', 'B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'BR', 'H1', 'H2', 'H3', 'H4', 'H5', 'TABLE', 'THEAD', 'TBODY', 'TR', 'TD', 'TH', 'SPAN', 'DIV', 'SMALL', 'SUB', 'SUP', 'HR', 'BLOCKQUOTE']);
const DROP = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'SVG', 'MATH', 'LINK', 'META']);

function clean(node: Node, doc: Document): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return doc.createTextNode(node.textContent ?? '');
  if (node.nodeType !== Node.ELEMENT_NODE) return null;
  const el = node as Element;
  const tag = el.tagName.toUpperCase();
  if (DROP.has(tag)) return null;
  const children = [...el.childNodes].map((c) => clean(c, doc)).filter((c): c is Node => c !== null);
  if (!ALLOWED.has(tag)) {
    const frag = doc.createDocumentFragment();
    for (const c of children) frag.appendChild(c);
    return frag;
  }
  const out = doc.createElement(tag.toLowerCase());
  for (const c of children) out.appendChild(c);
  return out;
}

export function sanitizeHtml(html: string): string {
  if (typeof DOMParser === 'undefined') return html.replace(/<[^>]*>/g, ' ');
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
  const target = document.implementation.createHTMLDocument('');
  const box = target.createElement('div');
  for (const c of [...parsed.body.childNodes]) {
    const n = clean(c, target);
    if (n) box.appendChild(n);
  }
  return box.innerHTML;
}
