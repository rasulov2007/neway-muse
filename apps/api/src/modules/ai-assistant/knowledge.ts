import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The TMS how-to guide NeWay AI reads (owner, 2026-10-20: "teach it the whole TMS"). Markdown files
 * in ./knowledge, one "## Section" per topic, with index.json naming each section, its keywords and
 * its page. The model asks for a topic; the closest sections come back verbatim, so the steps it
 * gives are the guide's, not its own guesses.
 */

export interface GuideEntry {
  id: string;
  file: string;
  title: string;
  keywords: string[];
  route: string | null;
}

export interface GuideSection extends GuideEntry {
  text: string;
}

let cache: { entries: GuideSection[] } | null = null;

function dir(): string {
  return join(__dirname, 'knowledge');
}

function sectionsOf(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  // <!-- … --> comments are notes for whoever edits the guide (TODOs); the model never reads them.
  const parts = markdown.replace(/<!--[\s\S]*?-->[ \t]*(\r?\n)?/g, '').split(/^## /m).slice(1);
  for (const p of parts) {
    const nl = p.indexOf('\n');
    const title = (nl < 0 ? p : p.slice(0, nl)).trim();
    out.set(title.toLowerCase(), `## ${p.trim()}`);
  }
  return out;
}

export function guide(): GuideSection[] {
  if (cache) return cache.entries;
  const base = dir();
  const indexPath = join(base, 'index.json');
  if (!existsSync(indexPath)) {
    cache = { entries: [] };
    return cache.entries;
  }
  const index = JSON.parse(readFileSync(indexPath, 'utf8')) as GuideEntry[];
  const files = new Map<string, Map<string, string>>();
  const entries: GuideSection[] = [];
  for (const e of index) {
    if (!files.has(e.file)) {
      const path = join(base, e.file);
      files.set(e.file, existsSync(path) ? sectionsOf(readFileSync(path, 'utf8')) : new Map());
    }
    const text = files.get(e.file)!.get(e.title.toLowerCase());
    if (text) entries.push({ ...e, keywords: e.keywords.map((k) => k.toLowerCase()), text });
  }
  cache = { entries };
  return entries;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2);

/** The best sections for a question: keyword hits weigh most, then title words, then body words. */
export function searchGuide(query: string, limit = 2): GuideSection[] {
  const q = words(query);
  if (q.length === 0) return [];
  const scored = guide().map((e) => {
    const title = e.title.toLowerCase();
    const body = e.text.toLowerCase();
    let score = 0;
    for (const w of q) {
      if (e.keywords.some((k) => k === w || k.startsWith(w) || w.startsWith(k))) score += 5;
      if (title.includes(w)) score += 3;
      if (body.includes(w)) score += 1;
    }
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.e);
}

/** Titles only, for the system prompt: the model sees what the guide covers without reading it all. */
export function guideTopics(): string {
  return guide()
    .map((e) => e.title)
    .join('; ');
}

/** The web pages that exist (knowledge/routes.json, from apps/web/src/routes). */
let routeCache: string[] | null = null;
function routes(): string[] {
  if (routeCache) return routeCache;
  const p = join(dir(), 'routes.json');
  routeCache = existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as string[]) : [];
  return routeCache;
}

const patternOf = (r: string) => new RegExp(`^${r.replace(/\$[A-Za-z]+/g, '[^/]+')}/?$`);

/**
 * A page the app really has: the route itself when it exists, else the nearest existing parent
 * (/accounting/billing -> /accounting), else null. The person is never sent to "Page not found".
 */
export function knownRoute(route: string): string | null {
  const clean = route.split('?')[0]!.replace(/\/+$/, '') || '/';
  const all = routes();
  if (all.length === 0) return clean;
  if (all.some((r) => patternOf(r).test(clean))) return clean;
  const parts = clean.split('/');
  while (parts.length > 1) {
    parts.pop();
    const parent = parts.join('/') || '/';
    if (all.includes(parent)) return parent;
  }
  return null;
}

/** Static pages, for the system prompt. */
export function pageList(): string {
  return routes()
    .filter((r) => !r.includes('$'))
    .join(' ');
}
