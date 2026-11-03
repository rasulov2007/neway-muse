import type { AiCard, AiDriveCard, AiProposalCard, AiProposalStatus } from '@neway/shared';
import { useNavigate } from '@tanstack/react-router';
import { ExternalLink, FileDown, MousePointerClick, Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, useToast } from '@/design-system';
import { AuthedFileLink } from '@/features/accounting/AuthedFileLink';
import { guideStore } from './GuideOverlay';
import { aiStore } from './store';
import { formatMoney } from '@/lib/format';
import { useProposalAction } from './api';

/** What a tool answered, drawn from the tool's own data - never from the model's words. */
export function AiCards({ cards, dryRun, onAsk }: { cards: AiCard[]; dryRun: boolean; onAsk?: (text: string) => void }) {
  const navigate = useNavigate();
  if (!cards.length) return null;
  const files = cards.filter((x) => x.kind === 'file');
  const links = cards.filter((x) => x.kind === 'link');
  const guides = cards.filter((x) => x.kind === 'guide');
  const rest = cards.filter((x) => x.kind !== 'file' && x.kind !== 'link' && x.kind !== 'guide');
  return (
    <div className="mt-2 flex flex-col gap-2">
      {rest.map((card, i) =>
        card.kind === 'table' ? (
          <TableCard key={i} card={card} />
        ) : card.kind === 'proposal' ? (
          <ProposalCard key={card.proposalId} card={card} dryRun={dryRun} />
        ) : card.kind === 'drive' ? (
          <DriveCard key={i} card={card} />
        ) : (
          <Notice key={i} tone={card.tone} text={card.text} />
        ),
      )}
      {files.length || links.length || guides.length ? (
        <div className="flex flex-wrap gap-2">
          {files.map((f) =>
            f.kind === 'file' ? (
              <AuthedFileLink key={f.path} path={f.path} fileName={f.fileName} className="inline-flex h-8 items-center gap-1.5 rounded-md border border-nw-border-strong bg-nw-panel px-2.5 text-xs font-semibold text-nw-text hover:bg-nw-hover">
                <FileDown className="size-3.5 text-nw-accent-ink" aria-hidden />
                {f.title}
              </AuthedFileLink>
            ) : null,
          )}
          {guides.map((g, i) =>
            g.kind === 'guide' ? (
              <button
                key={`guide-${i}`}
                type="button"
                onClick={() => {
                  aiStore.setOpen(false);
                  void navigate({ to: g.to as never }).then(() => guideStore.show(g.target, g.hint));
                }}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md bg-nw-accent px-2.5 text-xs font-semibold text-nw-on-accent hover:bg-nw-accent-hover"
              >
                <MousePointerClick className="size-3.5" aria-hidden />
                Show me: {g.target}
              </button>
            ) : null,
          )}
          {onAsk
            ? guides.map((g, i) =>
                g.kind === 'guide' ? (
                  <button
                    key={`do-${i}`}
                    type="button"
                    onClick={() => onAsk(`Do it for me on the screen: open ${g.to} and press “${g.target}”. Say what you press at each step.`)}
                    className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-nw-accent bg-nw-panel px-2.5 text-xs font-semibold text-nw-accent-ink hover:bg-nw-accent-tint"
                  >
                    <Sparkles className="size-3.5" aria-hidden />
                    Do it for me
                  </button>
                ) : null,
              )
            : null}
          {links.map((l) =>
            l.kind === 'link' ? (
              <button
                key={l.to}
                type="button"
                onClick={() => {
                  aiStore.setOpen(false);
                  void navigate({ to: l.to as never });
                }}
                className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-nw-accent bg-nw-panel px-2.5 text-xs font-semibold text-nw-accent-ink hover:bg-nw-accent-tint"
              >
                <ExternalLink className="size-3.5" aria-hidden />
                {l.label}
              </button>
            ) : null,
          )}
        </div>
      ) : null}
    </div>
  );
}

function TableCard({ card }: { card: Extract<AiCard, { kind: 'table' }> }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-nw-border bg-nw-panel">
      <div className="border-b border-nw-border px-3 py-2 text-sm font-semibold text-nw-text">{card.title}</div>
      {card.rows.length === 0 ? (
        <div className="px-3 py-3 text-sm text-nw-text-3">Nothing to show.</div>
      ) : (
        <div className="scroll-quiet max-h-80 overflow-auto">
          <table className="w-full border-collapse text-xs">
            <thead className="sticky top-0 bg-nw-subtle">
              <tr>
                {card.columns.map((c) => (
                  <th key={c} className="whitespace-nowrap border-b border-nw-border px-3 py-1.5 text-left font-semibold text-nw-text-2">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {card.rows.map((row, r) => (
                <tr key={r} className="border-b border-nw-border last:border-b-0">
                  {row.map((cell, c) => (
                    <td key={c} className="whitespace-nowrap px-3 py-1.5 text-nw-text">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {card.note ? <div className="border-t border-nw-border px-3 py-1.5 text-xs text-nw-text-3">{card.note}</div> : null}
    </div>
  );
}

const STATUS_WORD: Record<AiProposalStatus, { label: string; tone: 'info' | 'success' | 'warning' | 'danger' | 'neutral' }> = {
  awaiting: { label: 'Awaiting confirmation', tone: 'info' },
  confirmed: { label: 'Running', tone: 'info' },
  executed: { label: 'Done', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  stale: { label: 'Out of date', tone: 'warning' },
};

function ProposalCard({ card, dryRun }: { card: AiProposalCard; dryRun: boolean }) {
  const action = useProposalAction();
  const { toast } = useToast();
  const look = STATUS_WORD[card.status];
  const run = (what: 'confirm' | 'cancel') =>
    action.mutate(
      { id: card.proposalId, action: what },
      {
        onSuccess: (r) => toast({ tone: r.status === 'executed' ? 'success' : 'info', title: what === 'confirm' ? (r.result ?? 'Done') : 'Cancelled' }),
        onError: (e) => toast({ tone: 'danger', title: 'Not done', description: e instanceof Error ? e.message : undefined }),
      },
    );
  return (
    <div className="rounded-[10px] border border-nw-border bg-nw-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-nw-border px-3 py-2">
        <span className="text-sm font-semibold text-nw-text">{card.title}</span>
        <Badge tone={look.tone} size="sm" dot>
          {look.label}
        </Badge>
      </div>
      <div className="flex flex-col gap-1 px-3 py-2 text-sm text-nw-text">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-nw-text-2">
          <span>
            {card.count} item{card.count === 1 ? '' : 's'}
          </span>
          {card.totalCents !== null ? <span>Total {formatMoney(card.totalCents / 100)}</span> : null}
          {card.destination ? <span>To {card.destination}</span> : null}
        </div>
        {card.lines.length ? (
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-nw-text">
            {card.lines.map((l, i) => (
              <li key={i}>{l}</li>
            ))}
          </ul>
        ) : null}
        {(card.warnings ?? []).map((w, i) => (
          <Notice key={`w${i}`} tone="warning" text={w} />
        ))}
        {card.blocked.map((b, i) => (
          <Notice key={i} tone="danger" text={b} />
        ))}
        {card.result ? <div className="text-xs text-nw-text-2">{card.result}</div> : null}
      </div>
      {card.status === 'awaiting' ? (
        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-nw-border px-3 py-2">
          {dryRun ? <span className="mr-auto text-xs text-nw-text-3">Dry run is on: nothing will run.</span> : null}
          <Button size="sm" variant="ghost" onClick={() => run('cancel')} disabled={action.isPending}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" onClick={() => run('confirm')} disabled={dryRun || card.blocked.length > 0} loading={action.isPending}>
            Confirm
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const DRIVE_WORD: Record<AiDriveCard['status'], { label: string; tone: 'info' | 'success' | 'warning' | 'neutral' }> = {
  running: { label: 'Working on the screen', tone: 'info' },
  done: { label: 'Done on the screen', tone: 'success' },
  stopped: { label: 'Stopped', tone: 'neutral' },
  limit: { label: 'Stopped at the step limit', tone: 'warning' },
};

/** What NeWay AI pressed and typed on the screen, one line per step. */
function DriveCard({ card }: { card: AiDriveCard }) {
  const [all, setAll] = useState(false);
  const look = DRIVE_WORD[card.status];
  const shown = all ? card.log : card.log.slice(-6);
  return (
    <div className="rounded-[10px] border border-nw-border bg-nw-panel px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <MousePointerClick className="size-3.5 text-nw-accent-ink" aria-hidden />
        <Badge tone={look.tone} size="sm" dot>
          {look.label}
        </Badge>
        <span className="text-xs text-nw-text-3">
          {card.log.length} step{card.log.length === 1 ? '' : 's'}
        </span>
      </div>
      {shown.length ? (
        <ol className="mt-1.5 flex flex-col gap-0.5 text-xs text-nw-text-2">
          {shown.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      ) : null}
      {card.log.length > 6 && !all ? (
        <button type="button" onClick={() => setAll(true)} className="mt-1 cursor-pointer text-xs font-semibold text-nw-accent-ink hover:underline">
          Show all {card.log.length} steps
        </button>
      ) : null}
    </div>
  );
}

export function Notice({ tone, text }: { tone: 'info' | 'warning' | 'danger'; text: string }) {
  const cls =
    tone === 'danger'
      ? 'border-nw-urgent-border bg-nw-urgent-bg text-nw-urgent-text'
      : tone === 'warning'
        ? 'border-nw-warning-border bg-nw-warning-bg text-nw-warning-text'
        : 'border-nw-moving-border bg-nw-moving-bg text-nw-moving-text';
  return <div className={`rounded-md border px-3 py-2 text-xs ${cls}`}>{text}</div>;
}
