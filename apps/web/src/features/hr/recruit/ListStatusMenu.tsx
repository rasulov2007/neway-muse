import { useNavigate } from '@tanstack/react-router';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { RECRUIT_PROGRESS_LABELS, type RecruitRow } from '@neway/shared';
import { DropdownMenu, MenuItem, MenuSeparator, cn, useToast } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { statusRows, type StatusAction } from './status-rows';
import { ProgressBadge } from './RecruitKit';
import { recruitApi, useRecruitCandidate, useRecruitMutation } from './useRecruit';

/**
 * The progress badge in the candidate list opens the same status menu as the candidate page
 * (owner, 2026-10-08). The candidate is read when the menu opens, so every row says honestly what
 * it would do. "Contacted" is recorded right here; every other step opens the candidate page with
 * its dialog already open, where the full checks run.
 */
export function ListStatusMenu({ row, size = 'md' }: { row: RecruitRow; size?: 'md' | 'sm' }) {
  const [open, setOpen] = useState(false);
  const detail = useRecruitCandidate(row.key, { enabled: open });
  const navigate = useNavigate();
  const { toast } = useToast();
  const contacted = useRecruitMutation((leadId: string) => recruitApi.markContacted(leadId));
  const noAnswer = useRecruitMutation((leadId: string) => recruitApi.markNoAnswer(leadId));

  const act = (a: StatusAction) => {
    if (a === 'no-answer') {
      if (!row.leadId) return;
      noAnswer.mutate(row.leadId, {
        onSuccess: () => toast({ tone: 'success', title: `${row.name}: called, no answer` }),
        onError: (e) => toast({ tone: 'danger', title: 'Not changed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      });
      return;
    }
    if (a === 'contacted') {
      if (!row.leadId) return;
      contacted.mutate(row.leadId, {
        onSuccess: () => toast({ tone: 'success', title: `${row.name} marked as contacted` }),
        onError: (e) => toast({ tone: 'danger', title: 'Not changed', description: e instanceof ApiError ? e.message : 'Try again.' }),
      });
      return;
    }
    void navigate({ to: '/hr/recruiting/$candidateId', params: { candidateId: row.key }, search: { action: a } as never });
  };

  const c = detail.data;
  // In the list the case details are not loaded; dropping a case is offered and the candidate
  // page decides whether this case can be dropped.
  const rows = c ? statusRows(c, Boolean(c.caseId) && c.progress !== 'hired' && c.progress !== 'closed') : [];

  return (
    <DropdownMenu
      align="start"
      open={open}
      onOpenChange={setOpen}
      className="w-80"
      trigger={
        <button
          type="button"
          aria-label={`Status of ${row.name}: ${RECRUIT_PROGRESS_LABELS[row.progress]} — change`}
          className="rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nw-accent"
          data-testid="list-status-menu"
        >
          <ProgressBadge
            progress={row.progress}
            nextStep={row.nextStep}
            size={size}
            className={cn('cursor-pointer transition-[filter] hover:brightness-[0.97]', contacted.isPending && 'opacity-60')}
          />
        </button>
      }
    >
      {detail.isPending ? (
        <MenuItem disabled>Loading…</MenuItem>
      ) : detail.isError || !c ? (
        <MenuItem disabled>Could not load this candidate. Try again.</MenuItem>
      ) : !c.permissions.canManage ? (
        <MenuItem disabled>
          <span className="whitespace-normal">Changing the status needs the recruiting manage permission.</span>
        </MenuItem>
      ) : (
        rows.map((r, i) => (
          <div key={r.progress}>
            {i === rows.length - 1 ? <MenuSeparator /> : null}
            <MenuItem
              data-testid={`list-status-${r.progress}`}
              aria-current={r.progress === c.progress ? 'step' : undefined}
              disabled={!r.enabled}
              destructive={r.progress === 'closed' && r.enabled}
              icon={r.progress === c.progress ? <Check className="text-nw-accent" /> : <span className="size-4" />}
              onSelect={() => r.action && act(r.action)}
            >
              <span className="flex flex-col whitespace-normal">
                <span className={cn('font-medium', r.progress === c.progress && 'text-nw-accent-ink')}>
                  {r.label ?? RECRUIT_PROGRESS_LABELS[r.progress]}
                </span>
                {r.hint ? <span className="text-xs text-nw-text-3">{r.hint}</span> : null}
              </span>
            </MenuItem>
          </div>
        ))
      )}
    </DropdownMenu>
  );
}
