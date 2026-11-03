import { useEffect, useRef, useState, type ReactNode } from 'react';
import { cn } from '@/design-system';
import { GRID } from './sheet';
import type { Sheet } from './useSheet';

/**
 * One cell of a board: white, centred, the selection outline, the fill, the blue dot on a typed
 * override, and the editor - a textarea laid over the cell that grows past the column while the
 * text is long, so a long note stays readable while it is being written.
 */
export function SheetCell({
  sheet,
  r,
  c,
  text,
  typed,
  editable,
  sizeToContent,
  tint,
  className,
  title,
  onRestore,
  onContextMenu,
  rowSpan,
  spanRows,
  children,
}: {
  sheet: Sheet;
  r: string;
  c: string;
  /** What the editor opens with. */
  text: string;
  typed: boolean;
  editable: boolean;
  /** The cell takes the width its content needs (one line, never cut) and widens its column. */
  sizeToContent?: boolean;
  tint?: string;
  className?: string;
  title?: string;
  onRestore?: () => void;
  onContextMenu?: (event: React.MouseEvent) => void;
  /** A cell drawn once across several sheet rows (the weekly Comment spans a driver's four). */
  rowSpan?: number;
  /** The sheet rows the spanning cell stands for: selecting or editing any of them lights it. */
  spanRows?: string[];
  children?: ReactNode;
}) {
  const keys = spanRows && spanRows.length > 0 ? spanRows : [r];
  const selected = keys.some((k) => sheet.inRange(k, c));
  const anchor = keys.some((k) => sheet.isAnchor(k, c));
  const editing = keys.some((k) => sheet.isEditing(k, c));
  return (
    <td
      role="gridcell"
      aria-selected={selected || undefined}
      data-cell={`${r}|${c}`}
      title={title}
      rowSpan={rowSpan}
      onMouseDown={(e) => {
        if (e.button !== 0) return;
        if (sheet.click({ r, c }, e)) e.preventDefault();
      }}
      onMouseEnter={(e) => {
        if (e.buttons === 1) sheet.dragOver({ r, c });
      }}
      onDoubleClick={() => editable && sheet.open({ r, c })}
      onContextMenu={onContextMenu}
      className={cn(
        GRID.cell,
        'relative select-none',
        sizeToContent ? 'whitespace-nowrap' : 'max-w-0',
        editing ? 'z-30 overflow-visible' : sizeToContent ? '' : 'truncate',
        tint,
        selected && !(tint && tint.includes('bg-(--bd-')) && 'bg-nw-accent-tint/50',
        anchor && !editing && 'outline-2 -outline-offset-2 outline-nw-accent',
        !editable && 'cursor-default',
        className,
      )}
    >
      {editing ? <Editor sheet={sheet} initial={sheet.editing?.initial ?? text} /> : (children ?? text)}
      {/* A typed value carries no marker, as on the sheet. `onRestore` stays for the callers' menus. */}
      {typed && onRestore ? null : null}
    </td>
  );
}

function Editor({ sheet, initial }: { sheet: Sheet; initial: string }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }, []);
  // The cell's own width, or wider only when the text needs it (capped so it stays on screen).
  const width = `max(100%, ${Math.min(560, Math.round(value.length * 7.2 + 28))}px)`;
  const finish = (after: 'stay' | 'down' | 'next' | 'previous') => {
    if (done.current) return;
    done.current = true;
    void sheet.commitEditor(value, after);
  };
  return (
    <textarea
      ref={ref}
      rows={1}
      value={value}
      aria-label="Edit cell"
      onChange={(e) => {
        setValue(e.target.value);
        sheet.setPendingText(e.target.value);
      }}
      onBlur={() => finish('stay')}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          finish('down');
        } else if (e.key === 'Escape') {
          e.preventDefault();
          done.current = true;
          sheet.closeEditor();
        } else if (e.key === 'Tab') {
          e.preventDefault();
          finish(e.shiftKey ? 'previous' : 'next');
        }
      }}
      style={{ width, outline: 'none', boxShadow: 'none' }}
      className="absolute top-0 left-0 z-30 box-border h-full min-h-[26px] resize-none rounded-none border-2 border-nw-accent bg-nw-field px-2 py-1 text-left text-[13px] leading-5 whitespace-pre-wrap text-nw-text outline-none"
    />
  );
}
