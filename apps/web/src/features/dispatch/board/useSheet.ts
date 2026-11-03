import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError } from '@/lib/api-client';

/**
 * The Sheets editing model both boards use (owner: "it should be the same as Google Sheets").
 *
 * - First click selects; second click, Enter or F2 opens. Typing a character opens with it.
 * - Enter commits and moves down; Tab commits and moves to the next editable cell, Shift+Tab
 *   back; Esc cancels the edit or clears the selection.
 * - Arrows move; Shift+arrows, Shift+click and dragging extend a rectangle; a header click
 *   selects a column; Ctrl+A selects the grid.
 * - Delete clears what may be cleared (undo bar for 9 s). Ctrl+C copies tab-separated values;
 *   Ctrl+V pastes a block from the anchor and reports what did not fit; Ctrl+Z undoes the last
 *   50 edits, Ctrl+Y / Ctrl+Shift+Z redoes.
 * - Every write carries the versions the sheet last saw; a stale one is refused by the server
 *   and surfaced as a conflict instead of overwriting someone else's change.
 * - Saving / Saved / Save failed is reported through `saveState`.
 *
 * The sheet knows nothing about what a cell means: the caller reads and writes cells by their
 * row and column keys and says which are editable.
 */

export { copyText } from '@/lib/clipboard';

export interface CellRef {
  r: string;
  c: string;
}

export interface SheetRange {
  r1: number;
  r2: number;
  c1: number;
  c2: number;
}

export interface SheetWrite {
  r: string;
  c: string;
  /** The text typed; null clears the cell (explicit empty); `restore` brings the automatic value back. */
  text: string | null;
  restore?: boolean;
  /** The version the sheet saw when the write was decided; null = no typed cell. Undefined = no check. */
  expectedVersion?: number | null;
}

export interface CellInfo {
  text: string;
  editable: boolean;
  clearable: boolean;
  typed: boolean;
  /** The typed cell's version, null when the cell shows an automatic value. */
  version: number | null;
}

export interface UseSheetOptions {
  rows: string[];
  cols: string[];
  read: (r: string, c: string) => CellInfo;
  /** The write, as a batch, so a paste or an undo is one round trip. Resolves when saved. */
  write: (writes: SheetWrite[]) => Promise<void>;
  /** A cleared cell is named in the undo bar: "ETA cleared on HAMID ALI". */
  describe?: (r: string, c: string) => string;
  /** Something the paste could not place, in words, for the caller to show. */
  onNotice?: (message: string) => void;
}

interface UndoEntry {
  /** Reverses the edit. */
  undo: SheetWrite[];
  /** Re-applies it. */
  redo: SheetWrite[];
  label: string;
}

export type SaveState = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved'; at: number } | { kind: 'failed'; message: string; conflict: boolean };

export function useSheet({ rows, cols, read, write, describe, onNotice }: UseSheetOptions) {
  const [anchor, setAnchor] = useState<CellRef | null>(null);
  const [focus, setFocus] = useState<CellRef | null>(null);
  const [editing, setEditing] = useState<{ cell: CellRef; initial: string } | null>(null);
  const [undoBar, setUndoBar] = useState<{ label: string } | null>(null);
  const [saveState, setSaveState] = useState<SaveState>({ kind: 'idle' });
  const undoStack = useRef<UndoEntry[]>([]);
  const redoStack = useRef<UndoEntry[]>([]);
  const undoTimer = useRef<number | null>(null);
  const dragging = useRef(false);
  /** The editor's text as typed so far, and which cell it belongs to: what a click elsewhere must save. */
  const pendingText = useRef<string | null>(null);
  const editingRef = useRef<{ cell: CellRef; initial: string } | null>(null);

  const rowIndex = useMemo(() => new Map(rows.map((r, i) => [r, i])), [rows]);
  const colIndex = useMemo(() => new Map(cols.map((c, i) => [c, i])), [cols]);

  const range: SheetRange | null = useMemo(() => {
    if (!anchor) return null;
    const a = { r: rowIndex.get(anchor.r) ?? 0, c: colIndex.get(anchor.c) ?? 0 };
    const f = focus ? { r: rowIndex.get(focus.r) ?? a.r, c: colIndex.get(focus.c) ?? a.c } : a;
    return { r1: Math.min(a.r, f.r), r2: Math.max(a.r, f.r), c1: Math.min(a.c, f.c), c2: Math.max(a.c, f.c) };
  }, [anchor, focus, rowIndex, colIndex]);

  const inRange = useCallback(
    (r: string, c: string) => {
      if (!range) return false;
      const ri = rowIndex.get(r);
      const ci = colIndex.get(c);
      if (ri === undefined || ci === undefined) return false;
      return ri >= range.r1 && ri <= range.r2 && ci >= range.c1 && ci <= range.c2;
    },
    [range, rowIndex, colIndex],
  );
  const isAnchor = useCallback((r: string, c: string) => anchor !== null && anchor.r === r && anchor.c === c, [anchor]);
  const isEditing = useCallback((r: string, c: string) => editing !== null && editing.cell.r === r && editing.cell.c === c, [editing]);

  const rangeCells = useCallback((): CellRef[] => {
    if (!range) return [];
    const out: CellRef[] = [];
    for (let ri = range.r1; ri <= range.r2; ri += 1)
      for (let ci = range.c1; ci <= range.c2; ci += 1) {
        const r = rows[ri];
        const c = cols[ci];
        if (r !== undefined && c !== undefined) out.push({ r, c });
      }
    return out;
  }, [range, rows, cols]);

  /** Sends a batch, tracking the save state; a 409 is reported as a conflict. Throws on failure. */
  const send = useCallback(
    async (writes: SheetWrite[]) => {
      setSaveState({ kind: 'saving' });
      try {
        await write(writes);
        setSaveState({ kind: 'saved', at: Date.now() });
      } catch (error) {
        const conflict = error instanceof ApiError && error.status === 409;
        setSaveState({
          kind: 'failed',
          conflict,
          message: error instanceof Error ? error.message : 'Save failed',
        });
        throw error;
      }
    },
    [write],
  );

  /** A write with its undo, kept for Ctrl+Z and the undo bar. */
  const commit = useCallback(
    async (writes: SheetWrite[], label: string, force = false) => {
      // `force` is for the caller's own controls (the status menu): cells the keyboard may not edit.
      const live = force ? writes : writes.filter((w) => read(w.r, w.c).editable);
      if (live.length === 0) return;
      const undo: SheetWrite[] = [];
      const redo: SheetWrite[] = [];
      for (const w of live) {
        const before = read(w.r, w.c);
        undo.push(before.typed ? { r: w.r, c: w.c, text: before.text } : { r: w.r, c: w.c, text: null, restore: true });
        redo.push({ ...w, expectedVersion: undefined });
      }
      await send(live.map((w) => ({ ...w, expectedVersion: w.expectedVersion === undefined ? read(w.r, w.c).version : w.expectedVersion })));
      undoStack.current = [...undoStack.current.slice(-49), { undo, redo, label }];
      redoStack.current = [];
    },
    [read, send],
  );

  /**
   * Undo re-applies the previous values, carrying the version the sheet now shows. If someone
   * else wrote the cell since, the server refuses the undo and the conflict is shown instead of
   * their change being overwritten.
   */
  const undo = useCallback(async () => {
    const last = undoStack.current.pop();
    if (!last) return;
    try {
      await send(last.undo.map((w) => ({ ...w, expectedVersion: read(w.r, w.c).version })));
      redoStack.current.push(last);
    } catch {
      undoStack.current.push(last);
    }
    setUndoBar(null);
  }, [read, send]);

  const redo = useCallback(async () => {
    const last = redoStack.current.pop();
    if (!last) return;
    try {
      await send(last.redo.map((w) => ({ ...w, expectedVersion: read(w.r, w.c).version })));
      undoStack.current.push(last);
    } catch {
      redoStack.current.push(last);
    }
  }, [read, send]);

  const showUndoBar = useCallback((label: string) => {
    setUndoBar({ label });
    if (undoTimer.current) window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndoBar(null), 9000);
  }, []);


  /** The editor reports every keystroke here, so a click anywhere can save what was typed. */
  const setPendingText = useCallback((text: string) => {
    pendingText.current = text;
  }, []);

  /**
   * Saves the open editor's text before the selection moves. Clicking another cell unmounts
   * the editor before the browser fires its blur, so without this the typed text was lost and
   * only Enter or Tab saved it.
   */
  const flushEditor = useCallback(async () => {
    const ed = editingRef.current;
    const text = pendingText.current;
    if (!ed) return;
    editingRef.current = null;
    pendingText.current = null;
    setEditing(null);
    if (text === null) return;
    const before = read(ed.cell.r, ed.cell.c);
    if (text === before.text && (before.typed || text === '')) return;
    try {
      await commit([{ r: ed.cell.r, c: ed.cell.c, text }], `${ed.cell.c} on ${ed.cell.r}`);
    } catch {
      /* the save state carries the failure */
    }
  }, [read, commit]);

  const select = useCallback(
    (cell: CellRef, extend = false) => {
      void flushEditor();
      if (extend) setFocus(cell);
      else {
        setAnchor(cell);
        setFocus(null);
      }
    },
    [flushEditor],
  );

  const selectColumn = useCallback(
    (c: string) => {
      if (rows.length === 0) return;
      void flushEditor();
      setAnchor({ r: rows[0]!, c });
      setFocus({ r: rows[rows.length - 1]!, c });
    },
    [rows, flushEditor],
  );

  const selectAll = useCallback(() => {
    if (rows.length === 0 || cols.length === 0) return;
    void flushEditor();
    setAnchor({ r: rows[0]!, c: cols[0]! });
    setFocus({ r: rows[rows.length - 1]!, c: cols[cols.length - 1]! });
  }, [rows, cols, flushEditor]);

  const open = useCallback(
    (cell: CellRef, initial?: string) => {
      const info = read(cell.r, cell.c);
      if (!info.editable) return;
      setAnchor(cell);
      setFocus(null);
      const next = { cell, initial: initial ?? info.text };
      editingRef.current = next;
      pendingText.current = next.initial;
      setEditing(next);
    },
    [read],
  );

  /**
   * The first click selects, the second opens. Mouse down also starts a drag. Returns true when
   * this press opened the editor: the caller then stops the browser's own focus move, which would
   * otherwise blur the new editor and close it again.
   */
  const click = useCallback(
    (cell: CellRef, event?: { shiftKey?: boolean }): boolean => {
      if (event?.shiftKey) {
        select(cell, true);
        return false;
      }
      if (isAnchor(cell.r, cell.c) && !editing) {
        open(cell);
        return true;
      }
      select(cell);
      dragging.current = true;
      return false;
    },
    [editing, isAnchor, open, select],
  );

  /** Mouse enters a cell with the button down: the rectangle grows. */
  const dragOver = useCallback(
    (cell: CellRef) => {
      if (!dragging.current || editing) return;
      setFocus(cell);
    },
    [editing],
  );

  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const closeEditor = useCallback(() => {
    editingRef.current = null;
    pendingText.current = null;
    setEditing(null);
  }, []);


  const moveTo = useCallback(
    (from: CellRef, dr: number, dc: number): CellRef | null => {
      const ri = rowIndex.get(from.r);
      const ci = colIndex.get(from.c);
      if (ri === undefined || ci === undefined) return null;
      const nr = Math.min(rows.length - 1, Math.max(0, ri + dr));
      const nc = Math.min(cols.length - 1, Math.max(0, ci + dc));
      return { r: rows[nr]!, c: cols[nc]! };
    },
    [rows, cols, rowIndex, colIndex],
  );

  /** The next editable cell after `from` in reading order (or before it). */
  const nextEditable = useCallback(
    (from: CellRef, backwards: boolean): CellRef | null => {
      const ri = rowIndex.get(from.r) ?? 0;
      const ci = colIndex.get(from.c) ?? 0;
      const total = rows.length * cols.length;
      let index = ri * cols.length + ci;
      for (let step = 0; step < total; step += 1) {
        index = (index + (backwards ? -1 : 1) + total) % total;
        const cell = { r: rows[Math.floor(index / cols.length)]!, c: cols[index % cols.length]! };
        if (read(cell.r, cell.c).editable) return cell;
      }
      return null;
    },
    [rows, cols, rowIndex, colIndex, read],
  );

  const commitEditor = useCallback(
    async (text: string, after: 'stay' | 'down' | 'next' | 'previous' = 'stay') => {
      if (!editing || !editingRef.current) return;
      const { cell } = editing;
      editingRef.current = null;
      pendingText.current = null;
      setEditing(null);
      const before = read(cell.r, cell.c);
      if (!(text === before.text && (before.typed || text === ''))) {
        // Clicking in and out without changing anything never writes an override.
        try {
          await commit([{ r: cell.r, c: cell.c, text }], `${cell.c} on ${cell.r}`);
        } catch {
          // The save state carries the failure; the selection stays on the cell for a retry.
          setAnchor(cell);
          return;
        }
      }
      const target =
        after === 'down' ? moveTo(cell, 1, 0) : after === 'next' ? nextEditable(cell, false) : after === 'previous' ? nextEditable(cell, true) : null;
      if (target) {
        setAnchor(target);
        setFocus(null);
      }
    },
    [commit, editing, read, moveTo, nextEditable],
  );

  const move = useCallback(
    (dr: number, dc: number, extend: boolean) => {
      const base = extend ? (focus ?? anchor) : anchor;
      if (!base) return;
      const cell = moveTo(base, dr, dc);
      if (cell) select(cell, extend);
    },
    [anchor, focus, moveTo, select],
  );

  const clearSelection = useCallback(async () => {
    const cells = rangeCells().filter((x) => read(x.r, x.c).clearable);
    if (cells.length === 0) return;
    const first = cells[0]!;
    const before = read(first.r, first.c);
    const label = cells.length === 1 ? `${describe ? describe(first.r, first.c) : `${first.c} on ${first.r}`} - "${before.text}"` : `${cells.length} cells cleared`;
    await commit(
      cells.map((x) => ({ r: x.r, c: x.c, text: null })),
      label,
    );
    showUndoBar(label);
  }, [commit, describe, rangeCells, read, showUndoBar]);

  const copy = useCallback(async () => {
    if (!range) return;
    const lines: string[] = [];
    for (let ri = range.r1; ri <= range.r2; ri += 1) {
      const parts: string[] = [];
      for (let ci = range.c1; ci <= range.c2; ci += 1) {
        const r = rows[ri];
        const c = cols[ci];
        parts.push(r !== undefined && c !== undefined ? read(r, c).text.replace(/\t|\n/g, ' ') : '');
      }
      lines.push(parts.join('\t'));
    }
    const text = lines.join('\n');
    // The clipboard API needs a secure context; over plain http the old selection path still works.
    try {
      if (window.isSecureContext && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        return;
      }
    } catch {
      /* fall through to the selection path */
    }
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try {
      document.execCommand('copy');
    } finally {
      area.remove();
    }
  }, [range, rows, cols, read]);

  const paste = useCallback(
    async (text: string) => {
      if (!anchor) return;
      // Clipboards add a trailing newline and, from some sheets, a trailing tab: those are not
      // values. Trailing empty cells on every line are dropped before anything is counted.
      let grid = text
        .replace(/\r/g, '')
        .split('\n')
        .map((l) => l.split('\t'));
      while (grid.length > 0 && grid[grid.length - 1]!.every((v) => v === '')) grid.pop();
      grid = grid.map((line) => {
        const cells = [...line];
        while (cells.length > 1 && cells[cells.length - 1] === '') cells.pop();
        return cells;
      });
      if (grid.length === 0) return;
      const r0 = rowIndex.get(anchor.r) ?? 0;
      const c0 = colIndex.get(anchor.c) ?? 0;
      // One value pasted over a selected range fills the range, the Sheets way.
      const single = grid.length === 1 && grid[0]!.length === 1;
      const targets: { r: string; c: string; value: string }[] = [];
      if (single && range && (range.r2 > range.r1 || range.c2 > range.c1)) {
        for (const cell of rangeCells()) targets.push({ ...cell, value: grid[0]![0]! });
      } else {
        grid.forEach((line, dr) => {
          line.forEach((value, dc) => {
            const r = rows[r0 + dr];
            const c = cols[c0 + dc];
            targets.push({ r: r ?? '', c: c ?? '', value });
          });
        });
      }
      const writes: SheetWrite[] = [];
      let outside = 0;
      let readOnly = 0;
      for (const t of targets) {
        if (t.r === '' || t.c === '') {
          if (t.value !== '') outside += 1;
          continue;
        }
        if (!read(t.r, t.c).editable) {
          if (t.value !== '') readOnly += 1;
          continue;
        }
        writes.push({ r: t.r, c: t.c, text: t.value });
      }
      if (writes.length > 0) {
        await commit(writes, `${writes.length} cells pasted`);
        if (!single) {
          setFocus({ r: rows[Math.min(rows.length - 1, r0 + grid.length - 1)]!, c: cols[Math.min(cols.length - 1, c0 + Math.max(...grid.map((l) => l.length)) - 1)]! });
        }
      }
      const notes: string[] = [];
      if (outside > 0) notes.push(`${outside} value${outside === 1 ? '' : 's'} fell outside the grid and ${outside === 1 ? 'was' : 'were'} not pasted`);
      if (readOnly > 0) notes.push(`${readOnly} landed on read-only or calculated cells and ${readOnly === 1 ? 'was' : 'were'} skipped`);
      if (notes.length > 0) onNotice?.(`${writes.length} pasted · ${notes.join(' · ')}`);
    },
    [anchor, range, rangeCells, rowIndex, colIndex, rows, cols, read, commit, onNotice],
  );

  /** The keyboard, wired on the sheet's container. */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (editing) return; // the editor handles its own keys
      const meta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (meta && key === 'a') {
        event.preventDefault();
        selectAll();
        return;
      }
      if (!anchor) return;
      if (meta && key === 'z' && event.shiftKey) {
        event.preventDefault();
        void redo();
        return;
      }
      if (meta && key === 'z') {
        event.preventDefault();
        void undo();
        return;
      }
      if (meta && key === 'y') {
        event.preventDefault();
        void redo();
        return;
      }
      if (meta && key === 'c') {
        event.preventDefault();
        void copy();
        return;
      }
      if (meta && key === 'v') return; // the paste event carries the text
      switch (event.key) {
        case 'ArrowUp':
          event.preventDefault();
          return move(-1, 0, event.shiftKey);
        case 'ArrowDown':
          event.preventDefault();
          return move(1, 0, event.shiftKey);
        case 'ArrowLeft':
          event.preventDefault();
          return move(0, -1, event.shiftKey);
        case 'ArrowRight':
          event.preventDefault();
          return move(0, 1, event.shiftKey);
        case 'Tab': {
          event.preventDefault();
          const target = nextEditable(anchor, event.shiftKey);
          if (target) select(target);
          return;
        }
        case 'Enter':
        case 'F2':
          event.preventDefault();
          return open(anchor);
        case 'Escape':
          event.preventDefault();
          setAnchor(null);
          setFocus(null);
          return;
        case 'Delete':
        case 'Backspace':
          event.preventDefault();
          void clearSelection();
          return;
        default:
          if (event.key.length === 1 && !meta && !event.altKey) {
            event.preventDefault();
            open(anchor, event.key);
          }
      }
    },
    [anchor, editing, undo, redo, copy, move, open, clearSelection, selectAll, nextEditable, select],
  );

  const onPaste = useCallback(
    (event: React.ClipboardEvent) => {
      if (editing || !anchor) return;
      const text = event.clipboardData.getData('text/plain');
      if (!text) return;
      event.preventDefault();
      void paste(text);
    },
    [editing, anchor, paste],
  );

  useEffect(
    () => () => {
      if (undoTimer.current) window.clearTimeout(undoTimer.current);
    },
    [],
  );

  return {
    anchor,
    range,
    editing,
    undoBar,
    saveState,
    inRange,
    isAnchor,
    isEditing,
    rangeCells,
    click,
    dragOver,
    open,
    select,
    selectColumn,
    selectAll,
    commitEditor,
    closeEditor,
    setPendingText,
    flushEditor,
    commit,
    undo,
    redo,
    onKeyDown,
    onPaste,
    dismissUndoBar: () => setUndoBar(null),
    dismissSaveState: () => setSaveState({ kind: 'idle' }),
  };
}

export type Sheet = ReturnType<typeof useSheet>;
