import type { AiConversationView, AiMessageView, AiUsageView } from '@neway/shared';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUp, Camera, Check, ChevronDown, FileText, ImageIcon, Mic, Paperclip, Plus, Sparkles, Square, Volume2, X } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, DropdownMenu, IconButton, MenuItem, cn, useToast } from '@/design-system';
import { uploadFile, type StoredFile } from '@/lib/files';
import { createConversation, postClientResults, sendMessage, useAiKeys, useAiMessages, useAiUsage } from './api';
import { AiCards, Notice } from './Cards';
import { driveStore, useDrive } from './drive/driveStore';
import { Markdown } from './Markdown';
import { aiStore, drafts } from './store';
import { NO_VOICE_MESSAGE, VOICE_LANGS, canListen, listen, readAloud, stopSpeaking, type VoiceLang } from './voice';

const QUICK_ACTIONS = [
  'Check Ready-to-Bill loads',
  'Generate driver statements',
  'Calculate dispatcher payroll',
  'Show overdue invoices',
];

/** One chat: the messages and the composer. The drawer and the full page both show this. */
export function AiChat({ conversation, compact = false }: { conversation: AiConversationView | null; compact?: boolean }) {
  const id = conversation?.id ?? null;
  const keys = useAiKeys();
  const client = useQueryClient();
  const usage = useAiUsage();
  const messages = useAiMessages(id);
  const { toast } = useToast();
  const [pending, setPending] = useState<{ text: string; attachments: StoredFile[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runRef = useRef(0);
  const endRef = useRef<HTMLDivElement>(null);

  const list = messages.data ?? [];
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [list.length, pending]);

  const drive = useDrive();
  const driving = drive.phase === 'running' || drive.phase === 'confirm' || drive.phase === 'paused';

  /** NeWay AI drives the screen: the chat steps aside so the page is visible, the dock takes over. */
  const startDrive = (convId: string, dryRun: boolean, message: AiMessageView) => {
    aiStore.setOpen(false);
    void driveStore.start(message, {
      conversationId: convId,
      dryRun,
      post: async (cid, body) => {
        const r = await postClientResults(cid, body);
        client.setQueryData(keys.usage, r.usage);
        return r;
      },
      onMessage: (m) => client.setQueryData<AiMessageView[]>(keys.messages(convId), (old) => (old ?? []).map((x) => (x.id === m.id ? m : x))),
    });
  };

  const send = async (text: string, attachments: StoredFile[], model: string) => {
    const run = ++runRef.current;
    setError(null);
    setPending({ text, attachments });
    try {
      let convId = id;
      let dryRun = conversation?.dryRun ?? true;
      if (!convId) {
        const created = await createConversation(model);
        convId = created.id;
        dryRun = created.dryRun;
        aiStore.setActive(convId);
      }
      const r = await sendMessage(convId, { text, model, attachmentFileIds: attachments.map((a) => a.id) });
      client.setQueryData(keys.usage, r.usage);
      if (run !== runRef.current) return;
      client.setQueryData<AiMessageView[]>(keys.messages(convId), (old) => [...(old ?? []), ...r.messages]);
      // The assistant did something: the screens behind it re-read their records.
      if (r.messages.some((m) => m.cards.some((x) => x.kind === 'proposal' && x.status === 'executed'))) void client.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'ai' });
      const toDrive = r.messages.find((m) => m.pendingClientTools?.length);
      if (toDrive) startDrive(convId, dryRun, toDrive);
    } catch (e) {
      if (run !== runRef.current) return;
      setError(e instanceof Error ? e.message : 'The assistant could not answer.');
      return { failed: true as const };
    } finally {
      if (run === runRef.current) setPending(null);
      void client.invalidateQueries({ queryKey: keys.conversations });
    }
  };

  const stop = () => {
    runRef.current++;
    setPending(null);
    toast({ tone: 'info', title: 'Stopped', description: 'If the answer was already on its way it will appear in this chat.' });
    if (id) setTimeout(() => void client.invalidateQueries({ queryKey: keys.messages(id) }), 4000);
  };

  const empty = !id || (!messages.isLoading && list.length === 0);
  return (
    <div className="flex h-full min-h-0 flex-col" data-ai-chat>
      <div className={cn('scroll-quiet min-h-0 flex-1 overflow-y-auto', compact ? 'px-1' : 'px-4')}>
        {id && messages.isLoading ? (
          <div className="py-6 text-sm text-nw-text-3">Loading…</div>
        ) : empty && !pending ? (
          <EmptyChat usage={usage.data} onPick={(t) => void send(t, [], pickModel(usage.data, conversation))} />
        ) : (
          <div className="mx-auto flex max-w-3xl flex-col gap-4 py-4">
            {list.map((m) => (
              <MessageRow
                key={m.id}
                message={m}
                dryRun={conversation?.dryRun ?? true}
                onAsk={driving || pending ? undefined : (t) => void send(t, [], pickModel(usage.data, conversation))}
                unfinished={Boolean(m.pendingClientTools?.length) && drive.messageId !== m.id && !driving}
                onContinue={() => id && startDrive(id, conversation?.dryRun ?? true, m)}
                onStopRun={async () => {
                  if (!id || !m.pendingClientTools) return;
                  try {
                    const r = await postClientResults(id, { messageId: m.id, results: m.pendingClientTools.map((c) => ({ tool_use_id: c.id, content: 'Cancelled: the person pressed Stop.', is_error: true })), stop: true });
                    client.setQueryData<AiMessageView[]>(keys.messages(id), (old) => (old ?? []).map((x) => (x.id === m.id ? r.messages[0]! : x)));
                  } catch (e) {
                    setError(e instanceof Error ? e.message : 'Could not stop the run.');
                  }
                }}
              />
            ))}
            {pending ? (
              <>
                <UserBubble text={pending.text} files={pending.attachments.map((a) => a.fileName)} />
                <div className="flex items-center gap-2 text-sm text-nw-text-3">
                  <Sparkles className="size-4 animate-pulse text-nw-accent" aria-hidden />
                  Working…
                </div>
              </>
            ) : null}
            {error ? <Notice tone="danger" text={error} /> : null}
            <div ref={endRef} />
          </div>
        )}
      </div>
      <Composer key={id ?? 'new'} conversation={conversation} usage={usage.data} busy={pending !== null || driving} onSend={send} onStop={driving ? () => driveStore.stop() : stop} compact={compact} />
    </div>
  );
}

function pickModel(usage: AiUsageView | undefined, conversation: AiConversationView | null): string {
  return conversation?.model ?? usage?.defaultModel ?? 'claude-haiku-4-5';
}

function EmptyChat({ usage, onPick }: { usage: AiUsageView | undefined; onPick: (text: string) => void }) {
  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-10 text-center">
      <div className="flex size-11 items-center justify-center rounded-full bg-nw-accent-tint text-nw-accent-ink">
        <Sparkles className="size-5" aria-hidden />
      </div>
      <div className="text-lg font-bold text-nw-text">What would you like to do?</div>
      {usage?.configured ? (
        <div className="-mt-3 text-xs text-nw-text-3">Answering with {usage.models.find((m) => m.id === usage.defaultModel)?.label ?? usage.defaultModel}</div>
      ) : null}
      {usage && !usage.configured ? (
        <Notice tone="warning" text="NeWay AI is not connected on this server yet. An administrator has to add the key." />
      ) : null}
      <div className="grid w-full grid-cols-1 gap-2 sm:grid-cols-2">
        {QUICK_ACTIONS.map((q) => (
          <button
            key={q}
            type="button"
            disabled={!usage?.configured || usage.blocked}
            onClick={() => onPick(q)}
            className="cursor-pointer rounded-[10px] border border-nw-border bg-nw-panel px-3 py-2.5 text-left text-sm font-semibold text-nw-text hover:bg-nw-hover disabled:cursor-default disabled:opacity-45"
          >
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}

function UserBubble({ text, files }: { text: string; files: string[] }) {
  return (
    <div className="flex flex-col items-end gap-1">
      {files.length ? (
        <div className="flex flex-wrap justify-end gap-1">
          {files.map((f) => (
            <span key={f} className="inline-flex items-center gap-1 rounded-sm bg-nw-subtle px-2 py-0.5 text-xs text-nw-text-2">
              <FileText className="size-3" aria-hidden />
              {f}
            </span>
          ))}
        </div>
      ) : null}
      <div className="max-w-[85%] whitespace-pre-wrap rounded-[10px] bg-nw-accent-tint px-3 py-2 text-sm text-nw-text">{text}</div>
    </div>
  );
}

function MessageRow({
  message,
  dryRun,
  onAsk,
  unfinished,
  onContinue,
  onStopRun,
}: {
  message: AiMessageView;
  dryRun: boolean;
  onAsk?: (text: string) => void;
  /** A screen run that stopped half way (the page was reloaded): carry on or close it. */
  unfinished: boolean;
  onContinue: () => void;
  onStopRun: () => void;
}) {
  if (message.role === 'user') return <UserBubble text={message.text} files={message.attachments.map((a) => a.fileName)} />;
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-nw-accent-tint text-nw-accent-ink">
        <Sparkles className="size-3.5" aria-hidden />
      </div>
      <div className="min-w-0 flex-1">
        {message.text ? <Markdown text={message.text} /> : null}
        <AiCards cards={message.cards} dryRun={dryRun} onAsk={onAsk} />
        {unfinished ? (
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-nw-text-2">
            <span>This screen run did not finish.</span>
            <Button size="sm" variant="ghost" onClick={onStopRun}>
              Stop it
            </Button>
            <Button size="sm" variant="primary" onClick={onContinue}>
              Continue on screen
            </Button>
          </div>
        ) : null}
        {message.text ? <ReadAloudButton text={message.text} /> : null}
      </div>
    </div>
  );
}

/** Read aloud: the server's voice (Azure Speech) first, this computer's own as the fallback. Press again to stop. */
function ReadAloudButton({ text }: { text: string }) {
  const { toast } = useToast();
  const [state, setState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const done = () => {
    if (live.current) setState('idle');
  };
  const onClick = async () => {
    if (state !== 'idle') {
      stopSpeaking();
      setState('idle');
      return;
    }
    setState('loading');
    const outcome = await readAloud(text, done);
    if (!live.current) return;
    if (outcome === 'none') {
      setState('idle');
      toast({ tone: 'info', title: NO_VOICE_MESSAGE.title, description: NO_VOICE_MESSAGE.description });
    } else {
      setState((s) => (s === 'loading' ? 'playing' : s));
    }
  };
  return (
    <button type="button" onClick={() => void onClick()} className="mt-1 inline-flex cursor-pointer items-center gap-1 text-xs text-nw-text-3 hover:text-nw-text">
      {state === 'idle' ? <Volume2 className="size-3.5" aria-hidden /> : <Square className="size-3.5" aria-hidden />}
      {state === 'idle' ? 'Read aloud' : state === 'loading' ? 'Loading…' : 'Stop reading'}
    </button>
  );
}

function Composer({
  conversation,
  usage,
  busy,
  onSend,
  onStop,
  compact,
}: {
  conversation: AiConversationView | null;
  usage: AiUsageView | undefined;
  busy: boolean;
  onSend: (text: string, files: StoredFile[], model: string) => Promise<{ failed: true } | undefined>;
  onStop: () => void;
  compact: boolean;
}) {
  const id = conversation?.id ?? null;
  const { toast } = useToast();
  const [text, setText] = useState(() => drafts.get(id));
  const [files, setFiles] = useState<StoredFile[]>([]);
  const [uploading, setUploading] = useState(0);
  const [model, setModel] = useState<string | null>(null);
  const [lang, setLang] = useState<VoiceLang>('uz-UZ');
  const [listening, setListening] = useState(false);
  const voiceRef = useRef<ReturnType<typeof listen>>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const photo = useRef<HTMLInputElement>(null);
  const camera = useRef<HTMLInputElement>(null);
  const doc = useRef<HTMLInputElement>(null);

  // Another chat remounts the composer (keyed by chat), so the draft and model start fresh.
  useEffect(() => drafts.set(id, text), [id, text]);
  useEffect(() => () => voiceRef.current?.cancel(), []);
  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [text]);

  const chosen = model ?? pickModel(usage, conversation);
  const chosenDef = usage?.models.find((m) => m.id === chosen);
  const disabled = !usage?.configured || usage.blocked;

  const attach = async (list: FileList | null) => {
    if (!list) return;
    for (const f of Array.from(list).slice(0, 5 - files.length)) {
      setUploading((n) => n + 1);
      try {
        const stored = await uploadFile(f);
        setFiles((prev) => [...prev, stored]);
      } catch (e) {
        toast({ tone: 'danger', title: `${f.name} was not attached`, description: e instanceof Error ? e.message : undefined });
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const submit = async () => {
    const t = text.trim();
    if (!t || busy || disabled || uploading) return;
    voiceRef.current?.stop();
    const sent = files;
    setText('');
    setFiles([]);
    const r = await onSend(t, sent, chosen);
    if (r?.failed) {
      setText(t);
      setFiles(sent);
    }
  };

  const toggleMic = () => {
    if (listening) {
      voiceRef.current?.stop();
      return;
    }
    stopSpeaking();
    const before = text ? `${text.trimEnd()} ` : '';
    setListening(true);
    voiceRef.current = listen(lang, {
      text: (heard) => setText(before + heard),
      error: (message) => toast({ tone: 'warning', title: message }),
      end: () => {
        setListening(false);
        voiceRef.current = null;
        area.current?.focus();
      },
    });
  };

  return (
    <div className={cn('border-t border-nw-border pt-3', compact ? 'px-1' : 'px-4 pb-4')}>
      <div className="mx-auto max-w-3xl">
        {usage?.blocked ? (
          <div className="mb-2">
            <Notice tone="danger" text="This month’s NeWay AI budget is used up. It opens again on the 1st, or an administrator can raise the cap." />
          </div>
        ) : usage?.warn ? (
          <div className="mb-2">
            <Notice tone="warning" text={`This month’s NeWay AI spend is near the cap ($${(usage.monthCostCents / 100).toFixed(2)} of $${(usage.capCents / 100).toFixed(0)}).`} />
          </div>
        ) : null}
        <div className="rounded-[10px] border border-nw-border-strong bg-nw-field focus-within:border-nw-accent">
          {files.length || uploading ? (
            <div className="flex flex-wrap gap-1 px-2 pt-2">
              {files.map((f) => (
                <span key={f.id} className="inline-flex max-w-56 items-center gap-1 rounded-sm bg-nw-subtle px-2 py-0.5 text-xs text-nw-text-2">
                  {f.contentType.startsWith('image/') ? <ImageIcon className="size-3 shrink-0" aria-hidden /> : <FileText className="size-3 shrink-0" aria-hidden />}
                  <span className="truncate">{f.fileName}</span>
                  <button type="button" aria-label={`Remove ${f.fileName}`} className="cursor-pointer text-nw-text-3 hover:text-nw-text" onClick={() => setFiles((p) => p.filter((x) => x.id !== f.id))}>
                    <X className="size-3" />
                  </button>
                </span>
              ))}
              {uploading ? <span className="px-2 py-0.5 text-xs text-nw-text-3">Uploading…</span> : null}
            </div>
          ) : null}
          <textarea
            ref={area}
            rows={1}
            value={text}
            disabled={disabled}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder={listening ? 'Listening… speak, then edit before sending' : 'Ask NeWay AI…'}
            aria-label="Message"
            className="block max-h-50 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-sm text-nw-text outline-none placeholder:text-nw-text-3"
          />
          <div className="flex items-center gap-1 px-1.5 pb-1.5">
            <DropdownMenu
              align="start"
              side="top"
              trigger={
                <IconButton label="Attach" size="sm" disabled={disabled || files.length >= 5}>
                  <Plus />
                </IconButton>
              }
            >
              <MenuItem onSelect={() => photo.current?.click()}>
                <ImageIcon /> Upload photo
              </MenuItem>
              <MenuItem onSelect={() => camera.current?.click()}>
                <Camera /> Take photo
              </MenuItem>
              <MenuItem onSelect={() => doc.current?.click()}>
                <Paperclip /> Attach file
              </MenuItem>
            </DropdownMenu>
            <input ref={photo} type="file" accept="image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => (void attach(e.target.files), (e.target.value = ''))} />
            <input ref={camera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => (void attach(e.target.files), (e.target.value = ''))} />
            <input ref={doc} type="file" accept="application/pdf,image/png,image/jpeg,image/webp" multiple hidden onChange={(e) => (void attach(e.target.files), (e.target.value = ''))} />
            {usage && usage.models.length > 1 ? (
              <DropdownMenu
                align="start"
                side="top"
                trigger={
                  <Button variant="ghost" size="sm" iconRight={<ChevronDown />} disabled={disabled}>
                    {chosenDef?.label ?? chosen}
                  </Button>
                }
              >
                {usage.models.map((m) => (
                  <MenuItem key={m.id} onSelect={() => setModel(m.id)}>
                    {m.id === chosen ? <Check /> : <span className="size-4" />}
                    <span className="flex-1">{m.label}</span>
                    <span className="text-xs text-nw-text-3">{m.role}</span>
                  </MenuItem>
                ))}
              </DropdownMenu>
            ) : null}
            <div className="flex-1" />
            {canListen() ? (
              <>
                <button
                  type="button"
                  onClick={() => setLang(VOICE_LANGS[(VOICE_LANGS.findIndex((l) => l.code === lang) + 1) % VOICE_LANGS.length]!.code)}
                  disabled={listening}
                  title="Speech language"
                  className="cursor-pointer rounded-sm px-1.5 py-0.5 text-xs font-semibold text-nw-text-3 hover:bg-nw-hover hover:text-nw-text disabled:opacity-45"
                >
                  {VOICE_LANGS.find((l) => l.code === lang)!.label}
                </button>
                <IconButton label={listening ? 'Stop listening' : 'Speak'} size="sm" onClick={toggleMic} disabled={disabled} className={listening ? 'text-nw-urgent-icon' : undefined}>
                  <Mic className={listening ? 'animate-pulse' : undefined} />
                </IconButton>
              </>
            ) : null}
            {busy ? (
              <IconButton label="Stop" size="sm" onClick={onStop}>
                <Square />
              </IconButton>
            ) : (
              <button
                type="button"
                aria-label="Send"
                onClick={() => void submit()}
                disabled={!text.trim() || disabled || uploading > 0}
                className="flex size-7 cursor-pointer items-center justify-center rounded-full bg-nw-accent text-nw-on-accent hover:bg-nw-accent-hover disabled:cursor-default disabled:opacity-45"
              >
                <ArrowUp className="size-4" />
              </button>
            )}
          </div>
        </div>
        <div className="mt-1.5 text-center text-[11px] text-nw-text-3">NeWay AI can be wrong. Nothing is sent or paid until you confirm.</div>
      </div>
    </div>
  );
}
