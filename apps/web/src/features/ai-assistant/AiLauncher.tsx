import { useNavigate, useRouterState } from '@tanstack/react-router';
import { Plus, Sparkles } from 'lucide-react';
import { Button, Drawer } from '@/design-system';
import { useAiConversations, useCanUseAi } from './api';
import { AiChat } from './AiChat';
import { DryRunSwitch } from './DryRunSwitch';
import { useDrive } from './drive/driveStore';
import { aiStore, useAiStore } from './store';

/**
 * The NeWay AI side panel, opened from the button in the header beside the clock (owner,
 * 2026-10-30: the corner button sat on top of the page's own bars). The panel and the
 * /ai page share one active chat, so "Open full page" carries on the same conversation.
 */
export function AiLauncher() {
  const allowed = useCanUseAi();
  const path = useRouterState({ select: (s) => s.location.pathname });
  if (!allowed || path === '/ai') return null;
  return <Launcher />;
}

/** The header's NeWay AI button, beside the clock. Hidden while NeWay AI drives the screen. */
export function AiHeaderButton() {
  const allowed = useCanUseAi();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const driving = useDrive().phase !== 'idle';
  if (!allowed || path === '/ai' || driving) return null;
  return (
    <button
      type="button"
      data-ai-chat
      aria-label="Open NeWay AI"
      onClick={() => aiStore.setOpen(true)}
      className="mx-1 flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-full bg-nw-accent px-3 text-xs font-semibold text-nw-on-accent hover:bg-nw-accent-hover"
    >
      <Sparkles className="size-3.5" aria-hidden />
      <span className="hidden sm:inline">NeWay AI</span>
    </button>
  );
}

function Launcher() {
  const { open, activeId } = useAiStore();
  const navigate = useNavigate();
  const conversations = useAiConversations(open);
  const active = conversations.data?.find((c) => c.id === activeId) ?? null;
  return (
    <>
      <Drawer
        open={open}
        onOpenChange={aiStore.setOpen}
        size="lg"
        backdrop="clear"
        title="NeWay AI"
        headerExtra={<DryRunSwitch conversation={active} />}
        onOpenFullPage={() => {
          aiStore.setOpen(false);
          void navigate({ to: '/ai' });
        }}
        bodyClassName="flex flex-col px-4 py-0 pb-3"
      >
        <div className="flex items-center justify-between gap-2 py-2">
          <span className="truncate text-xs text-nw-text-3">{active ? active.title : 'New chat'}</span>
          <Button variant="ghost" size="sm" icon={<Plus />} onClick={() => aiStore.setActive(null)} disabled={!activeId}>
            New chat
          </Button>
        </div>
        <div className="min-h-0 flex-1">
          {activeId && conversations.isLoading ? <div className="py-6 text-sm text-nw-text-3">Loading…</div> : <AiChat conversation={active} compact />}
        </div>
      </Drawer>
    </>
  );
}
