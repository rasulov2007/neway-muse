import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { ChevronDown, ChevronUp, RefreshCw, Sunrise } from 'lucide-react';
import { useState } from 'react';
import { Button, StatusBadge, cn, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet, apiPost } from '@/lib/api-client';
import { Markdown } from './Markdown';

/**
 * The Morning brief (hackathon A2, 2026-11-03): NeWay AI runs every read-only check the person
 * may run - late loads, papers, route, fuel, billing, hiring - ranks what it found and writes it
 * up. The issues are the facts (symbol + word per Porcelain); the written brief is the model's
 * summary of them. "Run now" rebuilds it; AI_BRIEF_CRON on the server rebuilds it on a schedule.
 */

type BriefLevel = 'urgent' | 'warning' | 'info';
interface BriefIssue {
  level: BriefLevel;
  area: string;
  title: string;
  detail: string;
  link?: string;
}
interface BriefView {
  generatedAt: string;
  generatedAtEastern: string | null;
  today: string;
  issues: BriefIssue[];
  counts: Record<BriefLevel, number>;
  skipped: Array<{ area: string; reason: string }>;
  text: string;
  aiWritten: boolean;
  trigger: 'manual' | 'scheduled';
  requestedBy: string;
}

/** The status code each level renders through (design-system/status.ts), and its word. */
const LEVEL: Record<BriefLevel, { status: string; label: string }> = {
  urgent: { status: 'critical', label: 'Urgent' },
  warning: { status: 'warning', label: 'Warning' },
  info: { status: 'info', label: 'Info' },
};

const OPEN_KEY = 'nw-ai-brief-open';
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(OPEN_KEY, open ? '1' : '0');
  } catch {
    // a per-viewer convenience only
  }
}

export function MorningBrief() {
  const companyId = useAccount()?.companyId ?? null;
  const key = ['ai', companyId, 'brief'] as const;
  const client = useQueryClient();
  const { toast } = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(readOpen);
  const latest = useQuery({ queryKey: key, queryFn: () => apiGet<{ brief: BriefView | null }>('/ai/brief/latest'), staleTime: 60_000 });
  const run = useMutation({
    mutationFn: () => apiPost<BriefView>('/ai/brief', {}),
    onSuccess: (brief) => {
      client.setQueryData(key, { brief });
      void client.invalidateQueries({ queryKey: ['ai', companyId, 'usage'] });
    },
    onError: (e) => toast({ tone: 'danger', title: 'Brief not built', description: e instanceof Error ? e.message : undefined }),
  });
  const brief = latest.data?.brief ?? null;
  const toggle = () => {
    setOpen(!open);
    writeOpen(!open);
  };

  return (
    <section data-testid="morning-brief" className="border-b border-nw-border bg-nw-subtle">
      <div className="flex min-h-11 flex-wrap items-center gap-2 px-4 py-1.5">
        <Sunrise className="size-4 text-nw-accent" aria-hidden />
        <h2 className="text-sm font-bold text-nw-text">Morning brief</h2>
        {latest.isLoading ? (
          <span className="text-xs text-nw-text-3">Loading…</span>
        ) : brief ? (
          <>
            <span className="text-xs text-nw-text-3">
              {brief.generatedAtEastern ?? ''} · {brief.trigger === 'scheduled' ? 'scheduled' : brief.requestedBy}
            </span>
            <span className="flex flex-wrap items-center gap-1.5">
              {(['urgent', 'warning', 'info'] as const).map((level) =>
                brief.counts[level] > 0 ? <StatusBadge key={level} status={LEVEL[level].status} label={`${brief.counts[level]} ${LEVEL[level].label}`} size="sm" /> : null,
              )}
            </span>
          </>
        ) : (
          <span className="text-xs text-nw-text-3">Not run yet</span>
        )}
        <span className="flex-1" />
        <Button size="sm" variant="secondary" icon={<RefreshCw />} loading={run.isPending} onClick={() => run.mutate()}>
          {run.isPending ? 'Running…' : 'Run now'}
        </Button>
        <Button size="sm" variant="ghost" icon={open ? <ChevronUp /> : <ChevronDown />} onClick={toggle} aria-expanded={open} aria-label={open ? 'Hide the brief' : 'Show the brief'} />
      </div>
      {open ? (
        <div className="scroll-quiet max-h-[38dvh] overflow-y-auto px-4 pb-3">
          {latest.isLoading ? (
            <div className="py-2 text-sm text-nw-text-3">Loading…</div>
          ) : latest.isError ? (
            <div className="py-2 text-sm text-nw-text-3">The brief could not be read. Press Run now.</div>
          ) : !brief ? (
            <div className="py-2 text-sm text-nw-text-3">Press Run now: NeWay AI checks late loads, papers, routes, fuel, billing and hiring, and writes up what needs you first.</div>
          ) : (
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              <div className="min-w-0 rounded-[10px] border border-nw-border bg-nw-panel p-3 text-sm text-nw-text">
                <Markdown text={brief.text} />
                <div className="mt-2 text-2xs text-nw-text-3">{brief.aiWritten ? 'Written by NeWay AI from the checks listed beside it.' : 'NeWay AI is not set up on this server: the checks are listed as found.'}</div>
              </div>
              <ul className="min-w-0 divide-y divide-nw-border rounded-[10px] border border-nw-border bg-nw-panel">
                {brief.issues.length === 0 ? (
                  <li className="p-3 text-sm text-nw-text-3">Nothing needs attention right now.</li>
                ) : (
                  brief.issues.map((issue, i) => (
                    <li key={`${issue.area}-${i}`} className="flex items-start gap-2 p-2.5">
                      <StatusBadge status={LEVEL[issue.level].status} label={LEVEL[issue.level].label} size="sm" className="mt-0.5" />
                      <div className="min-w-0 flex-1">
                        <button
                          type="button"
                          disabled={!issue.link}
                          onClick={() => issue.link && void navigate({ to: issue.link as never })}
                          className={cn('text-left text-sm font-semibold text-nw-text', issue.link && 'cursor-pointer hover:underline')}
                        >
                          {issue.title}
                        </button>
                        <div className="text-xs text-nw-text-2">{issue.detail}</div>
                      </div>
                    </li>
                  ))
                )}
                {brief.skipped.length > 0 ? (
                  <li className="p-2.5 text-xs text-nw-text-3">Not included: {brief.skipped.map((s) => `${s.area} (${s.reason})`).join('; ')}</li>
                ) : null}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </section>
  );
}
