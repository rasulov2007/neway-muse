import { useCallback, useContext, useMemo, useState } from 'react';
import { AuthContext } from '@/features/auth/auth-context';

/**
 * Which team bands are folded on a board, kept between visits (owner, 2026-10-26: "I collapse
 * dispatchers, go to another page, come back - they are open again").
 *
 * A per-viewer convenience, so it lives in this browser's localStorage under the person, the
 * company and the page. Every read and write is guarded: without storage (private window, blocked
 * site data) the board still works, the bands simply start open. Only folded bands are stored, so
 * a team nobody folded - a new one included - opens expanded.
 */
export function collapsedStorageKey(
  page: string,
  companyId: string | null | undefined,
  userId: string | null | undefined,
): string {
  return `nw.board.collapsed.v1:${companyId ?? 'none'}:${userId ?? 'anon'}:${page}`;
}

export function readCollapsed(key: string): Set<string> {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    return new Set(
      Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [],
    );
  } catch {
    return new Set();
  }
}

export function writeCollapsed(key: string, ids: ReadonlySet<string>): void {
  try {
    if (ids.size === 0) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify([...ids]));
  } catch {
    // Storage refused: the fold still holds for this visit.
  }
}

/** The folded bands of one board page, and a toggle that folds or opens one band only. */
export function useCollapsedTeams(page: string): {
  collapsed: Set<string>;
  toggle: (teamId: string) => void;
} {
  const account = useContext(AuthContext)?.account ?? null;
  const key = collapsedStorageKey(page, account?.companyId, account?.userId);
  const [state, setState] = useState<{ key: string; ids: Set<string> }>(() => ({
    key,
    ids: readCollapsed(key),
  }));
  // Another company or person signed in on this tab: read their own folds.
  const current = useMemo(() => (state.key === key ? state.ids : readCollapsed(key)), [state, key]);
  const toggle = useCallback(
    (teamId: string) => {
      setState((s) => {
        const base = s.key === key ? s.ids : readCollapsed(key);
        const ids = new Set(base);
        if (ids.has(teamId)) ids.delete(teamId);
        else ids.add(teamId);
        writeCollapsed(key, ids);
        return { key, ids };
      });
    },
    [key],
  );
  return { collapsed: current, toggle };
}

/** Move one entry up or down a list; the rest keep their places. */
export function moveEntry<T>(list: readonly T[], index: number, by: -1 | 1): T[] {
  const to = index + by;
  if (to < 0 || to >= list.length) return [...list];
  const next = [...list];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}
