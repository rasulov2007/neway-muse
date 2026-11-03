import { Link } from '@tanstack/react-router';
import { ArrowRight, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useState } from 'react';
import { addDays, type RecruitCalendarEvent, type RecruitScope } from '@neway/shared';
import { Alert, Button, DatePicker, FormField, Input, Modal, Select, StatusSymbol, Textarea, cn, useToast } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';
import { formatDateTime } from '@/lib/format';
import { QuietState, RecruitCard } from './RecruitKit';
import { recruitApi, useRecruitCalendar, useRecruitList, useRecruitMetrics, useRecruitMutation } from './useRecruit';

const KIND_LABEL: Record<RecruitCalendarEvent['kind'], string> = {
  follow_up: 'Follow-up',
  travel: 'Travel',
  orientation: 'Orientation',
  hired: 'Hired',
};
const KIND_SYMBOL: Record<RecruitCalendarEvent['kind'], { family: 'warning' | 'moving' | 'info' | 'done'; cls: string }> = {
  follow_up: { family: 'warning', cls: 'text-nw-warning-icon' },
  travel: { family: 'moving', cls: 'text-nw-moving-icon' },
  orientation: { family: 'info', cls: 'text-nw-moving-icon' },
  hired: { family: 'done', cls: 'text-nw-done-icon' },
};
const DAY = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' });
const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const LONG = new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const utc = (d: string) => new Date(`${d}T12:00:00Z`);

/** Sunday of the week a date falls in. */
function weekStart(d: string): string {
  return addDays(d, -utc(d).getUTCDay());
}

/**
 * The recruiting calendar (owner's redesign, 2026-10-08): follow-up dates from notes, and the
 * travel, orientation and hire dates the funnel records. No separate event store: "Add follow-up"
 * writes a note with a date on the candidate, which is what the list and the metric read too.
 */
export function RecruitCalendar({ canSeeAll, canManage }: { canSeeAll: boolean; canManage: boolean }) {
  // "Today" is the server's (Eastern) today, as the list and the follow-up dates use it.
  const metrics = useRecruitMetrics('mine');
  const today = metrics.data?.today ?? companyToday();
  const [offset, setOffset] = useState(0);
  const start = addDays(weekStart(today), offset * 7);
  const setStart = (next: string) => setOffset(Math.round((Date.parse(next) - Date.parse(weekStart(today))) / (7 * 86_400_000)));
  const [scope, setScope] = useState<RecruitScope>('mine');
  const [kind, setKind] = useState<'all' | RecruitCalendarEvent['kind']>('all');
  const [selected, setSelected] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const end = addDays(start, 6);
  const events = useRecruitCalendar({ from: start, to: end, scope });
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const list = (events.data ?? []).filter((e) => kind === 'all' || e.kind === kind);
  const shown = selected ? list.filter((e) => e.date === selected || (e.overdue && selected === today && e.date < start)) : list;

  return (
    <div className="flex flex-col gap-5" data-testid="recruit-calendar">
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <RecruitCard>
          <div className="flex items-center justify-between gap-2">
            <Button variant="ghost" size="sm" aria-label="Previous week" icon={<ChevronLeft />} onClick={() => { setStart(addDays(start, -7)); setSelected(null); }} />
            <div className="text-center">
              <p className="text-lg font-semibold text-nw-text">{MONTH.format(utc(start))}</p>
              <button type="button" className="text-xs font-semibold text-nw-accent-ink hover:underline" onClick={() => { setStart(weekStart(today)); setSelected(null); }}>
                This week
              </button>
            </div>
            <Button variant="ghost" size="sm" aria-label="Next week" icon={<ChevronRight />} onClick={() => { setStart(addDays(start, 7)); setSelected(null); }} />
          </div>
          <div className="mt-4 grid grid-cols-7 gap-1 text-center" role="grid" aria-label="Week">
            {days.map((d) => {
              const count = list.filter((e) => e.date === d).length;
              const isToday = d === today;
              const isSel = selected === d;
              return (
                <button
                  key={d}
                  type="button"
                  role="gridcell"
                  aria-selected={isSel}
                  aria-label={`${LONG.format(utc(d))}: ${count} event${count === 1 ? '' : 's'}`}
                  onClick={() => setSelected(isSel ? null : d)}
                  className={cn(
                    'flex flex-col items-center gap-1 rounded-[10px] py-2 transition-colors duration-150 motion-reduce:transition-none',
                    isSel ? 'bg-nw-accent text-nw-on-accent' : 'hover:bg-nw-hover',
                  )}
                >
                  <span className={cn('text-xs', isSel ? 'text-nw-on-accent' : 'text-nw-text-3')}>{DAY.format(utc(d))}</span>
                  <span className={cn('text-lg font-semibold', isSel ? 'text-nw-on-accent' : isToday ? 'text-nw-accent-ink' : 'text-nw-text')}>{utc(d).getUTCDate()}</span>
                  <span className={cn('h-1.5 w-1.5 rounded-full', count ? (isSel ? 'bg-nw-on-accent' : 'bg-nw-accent') : 'bg-transparent')} />
                </button>
              );
            })}
          </div>
          <p className="mt-3 text-xs text-nw-text-3">Dates are US Eastern. Pick a day to see only its events.</p>
        </RecruitCard>
        <RecruitCard
          title={selected ? `Events · ${LONG.format(utc(selected))}` : 'Upcoming events'}
          action={
            <div className="flex items-center gap-2">
              {canSeeAll ? (
                <span className="w-32">
                  <Select aria-label="Whose events" value={scope} onValueChange={(v) => setScope(v as RecruitScope)} options={[{ value: 'mine', label: 'My leads' }, { value: 'all', label: 'All leads' }]} />
                </span>
              ) : null}
              <span className="w-36">
                <Select
                  aria-label="Event type"
                  value={kind}
                  onValueChange={(v) => setKind(v as typeof kind)}
                  options={[{ value: 'all', label: 'All events' }, ...(Object.keys(KIND_LABEL) as RecruitCalendarEvent['kind'][]).map((k) => ({ value: k, label: KIND_LABEL[k] }))]}
                />
              </span>
            </div>
          }
        >
          {events.isPending ? (
            <QuietState title="Loading…" />
          ) : events.error ? (
            <QuietState tone="error" title="The calendar could not be loaded" action={<Button variant="outline" onClick={() => void events.refetch()}>Try again</Button>} />
          ) : shown.length === 0 ? (
            <QuietState title="Nothing scheduled" description="Follow-up dates set on notes, travel, orientation and hires show here." />
          ) : (
            <ul className="flex flex-col divide-y divide-nw-border" data-testid="calendar-events">
              {shown.map((e) => (
                <li key={`${e.id}-${e.date}`}>
                  <Link to="/hr/recruiting/$candidateId" params={{ candidateId: e.candidateKey }} className="flex items-center gap-3 rounded-lg px-1 py-3 hover:bg-nw-hover">
                    <span className="flex size-9 items-center justify-center rounded-full bg-nw-subtle">
                      <StatusSymbol family={KIND_SYMBOL[e.kind].family} size={15} className={KIND_SYMBOL[e.kind].cls} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-nw-text">{KIND_LABEL[e.kind]}{e.overdue ? ' · overdue' : ''}</span>
                      <span className="block truncate text-[13px] text-nw-text-3">{e.candidateName}{e.recruiter && scope === 'all' ? ` · ${e.recruiter.name}` : ''}</span>
                    </span>
                    <span className="text-right text-[13px] text-nw-text-2">
                      {e.date === today ? 'Today' : LONG.format(utc(e.date))}
                      {e.at ? <span className="block text-xs text-nw-text-3">{formatDateTime(e.at).split(', ').pop()}</span> : null}
                    </span>
                    <ArrowRight aria-hidden className="size-4 text-nw-text-3" />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </RecruitCard>
      </div>
      {canManage ? (
        <div>
          <Button variant="outline" icon={<Plus />} onClick={() => setAdding(true)} data-testid="add-follow-up">
            Add follow-up
          </Button>
        </div>
      ) : null}
      {adding ? <AddFollowUpModal onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

/** A follow-up is a note with a date on a candidate: the same thing the Notes tab saves. */
function AddFollowUpModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const [q, setQ] = useState('');
  const [key, setKey] = useState('');
  const [date, setDate] = useState(companyToday());
  const [note, setNote] = useState('');
  const [tried, setTried] = useState(false);
  const candidates = useRecruitList({ scope: 'mine', filter: 'all', q: q || undefined, page: 1, pageSize: 50 });
  const save = useRecruitMutation((v: { key: string; note: string; followUpOn: string }) => recruitApi.addNote(v.key, { note: v.note, followUpOn: v.followUpOn }));
  const local = { key: key ? null : 'Choose the candidate', note: note.trim() ? null : 'Say what the follow-up is for' };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Add follow-up"
      description="Saved as a note with a follow-up date on the candidate."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() => {
              setTried(true);
              if (local.key || local.note) return;
              save.mutate({ key, note: note.trim(), followUpOn: date }, { onSuccess: () => { toast({ tone: 'success', title: 'Follow-up added' }); onClose(); } });
            }}
          >
            Add follow-up
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {save.error ? <Alert tone="danger" title="Not saved" description={save.error instanceof ApiError ? save.error.message : 'Try again.'} /> : null}
        <FormField label="Find a candidate">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, phone or email" />
        </FormField>
        <FormField label="Candidate" error={tried ? local.key : null}>
          <Select
            aria-label="Candidate"
            value={key}
            onValueChange={setKey}
            placeholder={candidates.isPending ? 'Loading…' : 'Choose the candidate'}
            options={(candidates.data?.rows ?? []).map((r) => ({ value: r.key, label: r.name }))}
          />
        </FormField>
        <FormField label="Date">
          <DatePicker aria-label="Date" value={date} onIsoChange={setDate} />
        </FormField>
        <FormField label="Note" error={tried ? local.note : null}>
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Call back about home time" />
        </FormField>
      </div>
    </Modal>
  );
}
