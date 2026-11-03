import { useNavigate } from '@tanstack/react-router';
import { MousePointerClick, Sparkles, Square, X } from 'lucide-react';
import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button, IconButton } from '@/design-system';
import { aiStore } from '../store';
import { driveStore, useDrive } from './driveStore';

/**
 * The small panel NeWay AI works from while it drives the screen: what it last said, the step it
 * is on, Stop, and - when needed - "Allow / Don't" for a risky press or "Continue?" after the
 * person took over. It replaces the chat drawer during a run so the page stays visible.
 */
export function DriveDock() {
  const d = useDrive();
  const navigate = useNavigate();

  useEffect(() => {
    driveStore.setNavigate((to) => navigate({ href: to }).then(() => undefined));
    return () => driveStore.setNavigate(null);
  }, [navigate]);

  if (d.phase === 'idle') return null;
  const active = d.phase !== 'done';
  const title = d.phase === 'confirm' ? 'NeWay AI needs your OK' : d.phase === 'paused' ? 'You took over' : active ? 'NeWay AI is working' : 'NeWay AI finished';

  return createPortal(
    <div
      data-ai-chat
      role="region"
      aria-label="NeWay AI at work"
      // A page dialog the AI opened must not close when the person answers here, and its
      // pointer lock on <body> must not make the dock unclickable.
      onPointerDown={(e) => e.stopPropagation()}
      className="pointer-events-auto fixed right-4 bottom-4 z-[210] flex w-[min(360px,calc(100vw-32px))] flex-col gap-2 rounded-[10px] border border-nw-border-strong bg-nw-raised p-3 text-sm text-nw-text shadow-menu"
    >
      <div className="flex items-center gap-2">
        <Sparkles className={`size-4 shrink-0 text-nw-accent ${d.phase === 'running' ? 'animate-pulse' : ''}`} aria-hidden />
        <span className="min-w-0 flex-1 truncate font-semibold">{title}</span>
        {active ? (
          <Button size="sm" variant="secondary" icon={<Square />} onClick={() => driveStore.stop()}>
            Stop
          </Button>
        ) : (
          <IconButton label="Close" size="sm" onClick={() => driveStore.dismiss()}>
            <X />
          </IconButton>
        )}
      </div>
      {d.said ? <p className="line-clamp-4 text-xs whitespace-pre-wrap text-nw-text-2">{d.said.replace(/\*\*|__|`/g, '')}</p> : null}
      {d.line && d.phase !== 'confirm' ? (
        <div className="flex items-center gap-1.5 text-xs text-nw-text-3" role="status">
          <MousePointerClick className="size-3.5 shrink-0 text-nw-accent-ink" aria-hidden />
          <span className="min-w-0 truncate">{d.line}</span>
        </div>
      ) : null}
      {d.phase === 'confirm' && d.ask ? (
        <div className="flex flex-col gap-2 rounded-md border border-nw-warning-border bg-nw-warning-bg px-3 py-2 text-xs text-nw-warning-text">
          <span>
            NeWay AI wants to press <strong>‘{d.ask.name}’</strong>
            {d.ask.where ? <> on {d.ask.where}</> : null}.
          </span>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => driveStore.answer(false)}>
              Don’t
            </Button>
            <Button size="sm" variant="primary" onClick={() => driveStore.answer(true)}>
              Allow
            </Button>
          </div>
        </div>
      ) : null}
      {d.phase === 'paused' ? (
        <div className="flex items-center justify-between gap-2 text-xs text-nw-text-2">
          <span>NeWay AI paused because you used the page. Continue?</span>
          <Button size="sm" variant="primary" onClick={() => driveStore.resume()}>
            Continue
          </Button>
        </div>
      ) : null}
      {d.error ? <div className="rounded-md border border-nw-urgent-border bg-nw-urgent-bg px-3 py-2 text-xs text-nw-urgent-text">{d.error}</div> : null}
      {!active ? (
        <div className="flex justify-end">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              driveStore.dismiss();
              aiStore.setOpen(true);
            }}
          >
            Open chat
          </Button>
        </div>
      ) : null}
    </div>,
    document.body,
  );
}
