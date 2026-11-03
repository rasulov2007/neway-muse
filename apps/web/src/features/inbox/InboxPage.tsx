import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Inbox, Paperclip, Send, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  MESSAGE_DEPARTMENT_LABEL,
  MESSAGE_DEPARTMENT_PERMISSION,
  MESSAGE_DEPARTMENTS,
  type ConversationSummary,
  type MessageDepartment,
  type MessageView,
} from '@neway/shared';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Textarea, cn, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { uploadFile, type StoredFile } from '@/lib/files';
import { attachmentLink, getThread, listConversations, markConversationRead, postMessage } from './api';

/** The inbox refreshes on its own; there is no socket, so it polls like the bell. */
export const INBOX_POLL_MS = 15_000;

const STATE_WORD: Record<NonNullable<MessageView['state']>, string> = { sent: 'Sent', received: 'Received', read: 'Read' };

function timeOf(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

/**
 * Inbox (mobile M4): the conversations drivers start from the app and the office answers, by
 * department. A department's threads show for the holders of its permission; the thread view
 * replies with text and files. Times are Eastern.
 */
export function InboxPage() {
  const account = useAccount();
  const search = useSearch({ strict: false }) as { c?: string; department?: string };
  const navigate = useNavigate();
  const departments = useMemo(
    () => MESSAGE_DEPARTMENTS.filter((d) => account?.permissions.includes(MESSAGE_DEPARTMENT_PERMISSION[d]) ?? false),
    [account],
  );
  const department = (departments as readonly string[]).includes(search.department ?? '') ? (search.department as MessageDepartment) : null;
  const selected = search.c ?? null;

  const list = useQuery({
    queryKey: ['inbox', 'list', department],
    queryFn: () => listConversations(department),
    refetchInterval: INBOX_POLL_MS,
  });
  const all = useQuery({ queryKey: ['inbox', 'list', null], queryFn: () => listConversations(null), refetchInterval: INBOX_POLL_MS, enabled: department !== null });
  const counts = (department === null ? list.data : all.data)?.unreadByDepartment ?? {};
  const totalUnread = (department === null ? list.data : all.data)?.unread ?? 0;

  const go = (next: { c?: string | null; department?: string | null }) =>
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const merged: Record<string, unknown> = { ...prev };
        if (next.c !== undefined) merged.c = next.c ?? undefined;
        if (next.department !== undefined) merged.department = next.department ?? undefined;
        return merged;
      },
      replace: true,
    } as never);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Inbox" description="Messages with drivers, by department. Drivers write from the NeWay app; replies reach their phone." />
      <div role="tablist" aria-label="Departments" className="flex flex-wrap gap-2">
        <DeptTab label="All" active={department === null} count={totalUnread} onClick={() => go({ department: null, c: null })} />
        {departments.map((d) => (
          <DeptTab key={d} label={MESSAGE_DEPARTMENT_LABEL[d]} active={department === d} count={counts[d] ?? 0} onClick={() => go({ department: d, c: null })} />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(280px,360px)_1fr]">
        <Card padding="none" aria-label="Conversations">
          {list.isPending ? (
            <p className="p-4 text-sm text-muted">Loading…</p>
          ) : list.isError ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} size="sm" />
          ) : list.data.conversations.length === 0 ? (
            <EmptyState size="sm" icon={<Inbox />} title="No conversations" description="When a driver writes to your department, the conversation shows here." />
          ) : (
            <ul className="divide-y divide-line">
              {list.data.conversations.map((c) => (
                <ConversationRow key={c.id} conversation={c} active={c.id === selected} onOpen={() => go({ c: c.id })} />
              ))}
            </ul>
          )}
        </Card>
        {selected ? <ThreadPanel id={selected} onClose={() => go({ c: null })} /> : (
          <Card>
            <EmptyState size="sm" icon={<Inbox />} title="Pick a conversation" description="Open a conversation to read it and reply." />
          </Card>
        )}
      </div>
    </div>
  );
}

function DeptTab({ label, active, count, onClick }: { label: string; active: boolean; count: number; onClick: () => void }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm',
        active ? 'border-nw-accent bg-nw-selected text-ink' : 'border-line bg-surface text-muted hover:bg-nw-hover',
      )}
    >
      {label}
      {count > 0 ? (
        <Badge tone="info" size="sm" aria-label={`${count} unread`}>
          {count}
        </Badge>
      ) : null}
    </button>
  );
}

function ConversationRow({ conversation: c, active, onOpen }: { conversation: ConversationSummary; active: boolean; onOpen: () => void }) {
  return (
    <li>
      <button type="button" onClick={onOpen} aria-current={active ? 'true' : undefined} className={cn('flex w-full flex-col gap-1 px-4 py-3 text-left', active ? 'bg-nw-selected' : 'hover:bg-nw-hover')}>
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-semibold text-ink">{c.title}</span>
          {c.unread > 0 ? (
            <Badge tone="info" size="sm" aria-label={`${c.unread} unread`}>
              {c.unread} new
            </Badge>
          ) : null}
        </span>
        <span className="truncate text-xs text-muted">
          {[c.departmentLabel, c.drivers.map((d) => d.name).join(', ')].filter(Boolean).join(' · ')}
        </span>
        {c.lastMessage ? (
          <span className="truncate text-xs text-muted">
            {c.lastMessage.senderName}: {c.lastMessage.body || (c.lastMessage.hasAttachments ? 'Sent a file' : '')} · {timeOf(c.lastMessage.at)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function ThreadPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const thread = useQuery({ queryKey: ['inbox', 'thread', id], queryFn: () => getThread(id), refetchInterval: INBOX_POLL_MS });
  const [body, setBody] = useState('');
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [uploading, setUploading] = useState(false);
  const draftKey = useRef(crypto.randomUUID());
  const fileInput = useRef<HTMLInputElement>(null);
  const unread = thread.data?.conversation.unread ?? 0;

  // Opening a thread with something new marks it read (the driver then sees "Read").
  useEffect(() => {
    if (unread > 0) {
      void markConversationRead(id).then(() => void queryClient.invalidateQueries({ queryKey: ['inbox', 'list'] }));
    }
  }, [id, unread, queryClient]);

  const send = useMutation({
    mutationFn: () => postMessage(id, body.trim(), files.map((f) => f.id), draftKey.current),
    onSuccess: () => {
      setBody('');
      setFiles([]);
      draftKey.current = crypto.randomUUID();
      void queryClient.invalidateQueries({ queryKey: ['inbox'] });
    },
    onError: (error) => toast({ tone: 'danger', title: 'Message not sent', description: error instanceof Error ? error.message : String(error) }),
  });

  const attach = async (list: FileList | null) => {
    if (!list?.length) return;
    setUploading(true);
    try {
      const stored = await Promise.all([...list].map((f) => uploadFile(f)));
      setFiles((prev) => [...prev, ...stored]);
    } catch (error) {
      toast({ tone: 'danger', title: 'File not attached', description: error instanceof Error ? error.message : String(error) });
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const openAttachment = async (fileId: string) => {
    const tab = window.open('', '_blank');
    try {
      const link = await attachmentLink(id, fileId);
      if (tab) tab.location.href = link.url;
      else window.open(link.url, '_blank');
    } catch (error) {
      tab?.close();
      toast({ tone: 'danger', title: 'Could not open the file', description: error instanceof Error ? error.message : String(error) });
    }
  };

  if (thread.isPending) return <Card><p className="text-sm text-muted">Loading…</p></Card>;
  if (thread.isError) return <Card><ErrorState error={thread.error} onRetry={() => void thread.refetch()} size="sm" /></Card>;
  const { conversation, messages } = thread.data;
  const canSend = (body.trim().length > 0 || files.length > 0) && !uploading && !send.isPending;

  return (
    <Card
      padding="none"
      title={conversation.title}
      description={[conversation.departmentLabel, conversation.drivers.map((d) => d.name).join(', ')].filter(Boolean).join(' · ')}
      actions={
        <Button variant="ghost" size="sm" icon={<X />} onClick={onClose} aria-label="Close conversation">
          Close
        </Button>
      }
    >
      <ol aria-label="Messages" className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto p-4">
        {messages.length === 0 ? <li className="text-sm text-muted">No messages yet.</li> : null}
        {messages.map((m) => (
          <li key={m.id} className={cn('flex flex-col gap-1', m.sender.isMe ? 'items-end' : 'items-start')}>
            <span className="text-xs text-muted">
              {m.sender.name} · {timeOf(m.createdAt)}
            </span>
            {m.body ? (
              <p className={cn('max-w-[80%] whitespace-pre-wrap rounded-lg border px-3 py-2 text-sm', m.sender.isMe ? 'border-nw-accent bg-nw-selected text-ink' : 'border-line bg-surface text-ink')}>{m.body}</p>
            ) : null}
            {m.attachments.map((a) => (
              <Button key={a.fileId} variant="secondary" size="sm" icon={<Paperclip />} onClick={() => void openAttachment(a.fileId)}>
                {a.fileName}
              </Button>
            ))}
            {m.state ? <span className="text-xs text-muted">{STATE_WORD[m.state]}</span> : null}
          </li>
        ))}
      </ol>
      <form
        className="flex flex-col gap-2 border-t border-line p-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (canSend) send.mutate();
        }}
      >
        <label htmlFor={`reply-${id}`} className="sr-only">
          Reply
        </label>
        <Textarea id={`reply-${id}`} rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Type a message…" />
        {files.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Attached files">
            {files.map((f) => (
              <li key={f.id}>
                <Badge tone="neutral" size="sm">{f.fileName}</Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-center justify-between gap-2">
          <input ref={fileInput} type="file" multiple className="hidden" aria-label="Attach files" onChange={(e) => void attach(e.target.files)} />
          <Button type="button" variant="secondary" size="sm" icon={<Paperclip />} loading={uploading} onClick={() => fileInput.current?.click()}>
            Attach
          </Button>
          <Button type="submit" variant="primary" size="sm" icon={<Send />} loading={send.isPending} disabled={!canSend}>
            Send
          </Button>
        </div>
      </form>
    </Card>
  );
}
