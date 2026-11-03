import type { AiConversationView, AiUsageView } from '@neway/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Archive, MoreHorizontal, Pencil, Plus, Search, Sparkles } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button, DropdownMenu, IconButton, MenuItem, cn, useToast } from '@/design-system';
import { archiveConversation, updateConversation, useAiConversations, useAiKeys, useAiUsage } from './api';
import { AiChat } from './AiChat';
import { DryRunSwitch } from './DryRunSwitch';
import { MorningBrief } from './MorningBrief';
import { aiStore, useAiStore } from './store';

/** The full NeWay AI page: past chats on the left, the active chat on the right. */
export function NeWayAiPage() {
  const { activeId } = useAiStore();
  const conversations = useAiConversations();
  const usage = useAiUsage();
  const active = conversations.data?.find((c) => c.id === activeId) ?? null;

  return (
    <div data-ai-chat className="flex h-[calc(100dvh-var(--nw-topbar-height)-40px)] min-h-120 overflow-hidden rounded-[10px] border border-nw-border bg-nw-panel">
      <aside className="hidden w-68 shrink-0 flex-col border-r border-nw-border bg-nw-subtle md:flex">
        <ChatList conversations={conversations.data} loading={conversations.isLoading} activeId={activeId} />
        <UsageMeter usage={usage.data} />
      </aside>
      <section className="flex min-w-0 flex-1 flex-col">
        <header className="flex min-h-12 flex-wrap items-center gap-2 border-b border-nw-border px-4 py-2">
          <Sparkles className="size-4 text-nw-accent" aria-hidden />
          <h1 className="text-md font-bold text-nw-text">NeWay AI</h1>
          <span className="min-w-0 flex-1 truncate text-xs text-nw-text-3">{active?.title ?? ''}</span>
          <Button variant="ghost" size="sm" icon={<Plus />} className="md:hidden" onClick={() => aiStore.setActive(null)}>
            New chat
          </Button>
          <DryRunSwitch conversation={active} />
        </header>
        <MorningBrief />
        <div className="min-h-0 flex-1">
          {activeId && conversations.isLoading ? <div className="p-4 text-sm text-nw-text-3">Loading…</div> : <AiChat conversation={active} />}
        </div>
      </section>
    </div>
  );
}

function group(updatedAt: string, now: Date): string {
  const day = (d: Date) => new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' })).setHours(0, 0, 0, 0);
  const diff = Math.round((day(now) - day(new Date(updatedAt))) / 86_400_000);
  if (diff <= 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  if (diff < 7) return 'Previous 7 days';
  return 'Older';
}

function ChatList({ conversations, loading, activeId }: { conversations: AiConversationView[] | undefined; loading: boolean; activeId: string | null }) {
  const [q, setQ] = useState('');
  const groups = useMemo(() => {
    const now = new Date();
    const out = new Map<string, AiConversationView[]>();
    for (const c of conversations ?? []) {
      if (q && !c.title.toLowerCase().includes(q.toLowerCase())) continue;
      const g = group(c.updatedAt, now);
      out.set(g, [...(out.get(g) ?? []), c]);
    }
    return [...out.entries()];
  }, [conversations, q]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-col gap-2 p-3">
        <Button variant="primary" icon={<Plus />} fullWidth onClick={() => aiStore.setActive(null)}>
          New chat
        </Button>
        <label className="flex h-8 items-center gap-2 rounded-md border border-nw-border bg-nw-field px-2">
          <Search className="size-3.5 text-nw-text-3" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search chats" aria-label="Search chats" className="min-w-0 flex-1 bg-transparent text-sm text-nw-text outline-none placeholder:text-nw-text-3" />
        </label>
      </div>
      <div className="scroll-quiet min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {loading ? (
          <div className="px-2 py-2 text-sm text-nw-text-3">Loading…</div>
        ) : groups.length === 0 ? (
          <div className="px-2 py-2 text-sm text-nw-text-3">{q ? 'No chat matches.' : 'No chats yet.'}</div>
        ) : (
          groups.map(([label, list]) => (
            <div key={label} className="mb-2">
              <div className="px-2 py-1 text-xs font-semibold text-nw-text-3">{label}</div>
              {list.map((c) => (
                <ChatItem key={c.id} conversation={c} active={c.id === activeId} />
              ))}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ChatItem({ conversation, active }: { conversation: AiConversationView; active: boolean }) {
  const client = useQueryClient();
  const keys = useAiKeys();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);

  const rename = async () => {
    setEditing(false);
    const t = title.trim();
    if (!t || t === conversation.title) return setTitle(conversation.title);
    try {
      await updateConversation(conversation.id, { title: t });
      await client.invalidateQueries({ queryKey: keys.conversations });
    } catch (e) {
      setTitle(conversation.title);
      toast({ tone: 'danger', title: 'Not renamed', description: e instanceof Error ? e.message : undefined });
    }
  };

  const archive = async () => {
    try {
      await archiveConversation(conversation.id);
      if (active) aiStore.setActive(null);
      await client.invalidateQueries({ queryKey: keys.conversations });
      toast({ tone: 'success', title: 'Chat archived' });
    } catch (e) {
      toast({ tone: 'danger', title: 'Not archived', description: e instanceof Error ? e.message : undefined });
    }
  };

  if (editing)
    return (
      <input
        autoFocus
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        onBlur={() => void rename()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void rename();
          if (e.key === 'Escape') {
            setTitle(conversation.title);
            setEditing(false);
          }
        }}
        aria-label="Chat name"
        maxLength={120}
        className="h-8 w-full rounded-md border border-nw-accent bg-nw-field px-2 text-sm text-nw-text outline-none"
      />
    );
  return (
    <div className={cn('group flex items-center rounded-md', active ? 'bg-nw-selected' : 'hover:bg-nw-hover')}>
      <button type="button" onClick={() => aiStore.setActive(conversation.id)} className="min-w-0 flex-1 cursor-pointer truncate px-2 py-1.5 text-left text-sm text-nw-text">
        {conversation.title}
      </button>
      <DropdownMenu
        trigger={
          <IconButton label="Chat actions" size="sm" className={cn('mr-0.5', active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100')}>
            <MoreHorizontal />
          </IconButton>
        }
      >
        <MenuItem onSelect={() => setEditing(true)}>
          <Pencil /> Rename
        </MenuItem>
        <MenuItem onSelect={() => void archive()}>
          <Archive /> Archive
        </MenuItem>
      </DropdownMenu>
    </div>
  );
}

function UsageMeter({ usage }: { usage: AiUsageView | undefined }) {
  if (!usage) return <div className="border-t border-nw-border p-3 text-xs text-nw-text-3">Loading…</div>;
  const share = usage.capCents ? Math.min(1, usage.monthCostCents / usage.capCents) : 0;
  return (
    <div className="border-t border-nw-border p-3">
      <div className="flex justify-between text-xs text-nw-text-2">
        <span>This month</span>
        <span>
          ${(usage.monthCostCents / 100).toFixed(2)} of ${(usage.capCents / 100).toFixed(0)}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-nw-track">
        <div className={cn('h-full rounded-full', usage.blocked ? 'bg-nw-danger' : usage.warn ? 'bg-nw-warning-icon' : 'bg-nw-accent')} style={{ width: `${share * 100}%` }} />
      </div>
      {usage.blocked ? <div className="mt-1 text-xs text-nw-urgent-text">Budget used up</div> : usage.warn ? <div className="mt-1 text-xs text-nw-warning-text">Near the cap</div> : null}
    </div>
  );
}
