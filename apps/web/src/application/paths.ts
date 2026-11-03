/**
 * Dotted answer paths ("licenses.0.number"), the same spelling the shared `dotAppMissing` uses for
 * its keys, so a missing item points straight at the field that shows it.
 */

const split = (path: string) => path.split('.').filter(Boolean);

export function getP(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const k of split(path)) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** An immutable set: every object or array on the way is copied, nothing else is touched. */
export function setP<T>(obj: T, path: string, value: unknown): T {
  const keys = split(path);
  const put = (node: unknown, i: number): unknown => {
    const k = keys[i]!;
    const nextIsIndex = /^\d+$/.test(keys[i + 1] ?? '');
    const isIndex = /^\d+$/.test(k);
    const base: Record<string, unknown> | unknown[] = Array.isArray(node)
      ? [...node]
      : node && typeof node === 'object'
        ? { ...(node as Record<string, unknown>) }
        : isIndex
          ? []
          : {};
    const child = (base as Record<string, unknown>)[k];
    const v = i === keys.length - 1 ? value : put(child ?? (nextIsIndex ? [] : {}), i + 1);
    (base as Record<string, unknown>)[k] = v;
    return base;
  };
  if (keys.length === 0) return obj;
  return put(obj, 0) as T;
}

/** A short random id for a client-made row (employers carry one: the SPH request is signed per id). */
export function shortId(): string {
  const a = new Uint8Array(5);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}
