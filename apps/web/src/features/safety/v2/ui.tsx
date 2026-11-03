import { Check, ClipboardList, FileText, Image as ImageIcon, Paperclip, Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type ReactNode } from 'react';
import {
  SAFETY_DOCUMENT_KINDS,
  SAFETY_DOCUMENT_KIND_LABEL,
  type SafetyCaseType,
  type SafetyDocument,
  type SafetyDocumentKind,
  type SafetyTimelineEntry,
} from '@neway/shared';
import {
  Avatar,
  Button,
  Card,
  DatePicker,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  cn,
} from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { formatDateTime, formatIsoDate, formatMoney } from '@/lib/format';
import { safetyApi, useCan, useSafetyPeople, useSafetyWrite } from './api';

/** The words every Safety v2 page uses before its data arrives (CLAUDE.md: never a 0 or a dash). */
export function Loading({ className }: { className?: string }) {
  return <div className={cn('px-4 py-10 text-center text-sm text-nw-text-3', className)}>Loading…</div>;
}

export function LoadError({ error }: { error: unknown }) {
  return (
    <div className="rounded-[10px] border border-nw-urgent-border bg-nw-urgent-bg px-4 py-3 text-sm text-nw-urgent-text">
      Could not load: {error instanceof Error ? error.message : String(error)}
    </div>
  );
}

/** Page title block as the mockups draw it: title, one line under it, actions on the right. */
export function SafetyTitle({ title, subtitle, actions, back }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; back?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        {back}
        <h1 className="text-[22px] font-extrabold tracking-[-.022em] text-nw-text">{title}</h1>
        {subtitle ? <div className="mt-0.5 text-sm text-nw-text-2">{subtitle}</div> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </header>
  );
}

/** A count tile with its icon in a tinted square, like the overview mockup. */
export function CountTile({
  icon,
  tone,
  value,
  label,
  hint,
  onClick,
}: {
  icon: ReactNode;
  tone: 'urgent' | 'warning' | 'done' | 'moving' | 'neutral' | 'accent';
  value: number | null | undefined;
  label: string;
  hint?: string;
  onClick?: () => void;
}) {
  const tint = {
    urgent: 'bg-nw-urgent-bg text-nw-urgent-icon',
    warning: 'bg-nw-warning-bg text-nw-warning-icon',
    done: 'bg-nw-done-bg text-nw-done-icon',
    moving: 'bg-nw-moving-bg text-nw-moving-icon',
    neutral: 'bg-nw-neutral-bg text-nw-neutral-icon',
    accent: 'bg-nw-accent-tint text-nw-accent-ink',
  }[tone];
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex min-w-0 items-start gap-3 rounded-[10px] border border-nw-border bg-nw-panel p-4 text-left',
        onClick && 'cursor-pointer hover:bg-nw-hover',
      )}
    >
      <span className={cn('grid size-10 shrink-0 place-items-center rounded-[9px] [&_svg]:size-5', tint)} aria-hidden>
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-[22px] leading-7 font-extrabold text-nw-text">{value === null || value === undefined ? 'Loading…' : value}</span>
        <span className="block text-sm font-semibold text-nw-text">{label}</span>
        {hint ? <span className="block text-xs text-nw-text-3">{hint}</span> : null}
      </span>
    </Tag>
  );
}

export interface StepDef {
  key: string;
  label: string;
  sub?: string | null;
}

/** Done steps get a check, the current one is filled, the rest wait. */
/** `administrative`: the case was closed out of order, so no earlier step is drawn as done. */
export function CaseStepper({ steps, current, finished, administrative = false }: { steps: StepDef[]; current: string; finished?: boolean; administrative?: boolean }) {
  const at = steps.findIndex((s) => s.key === current);
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-3 rounded-[10px] border border-nw-border bg-nw-panel px-4 py-3" aria-label="Progress">
      {steps.map((step, i) => {
        const done = !administrative && (finished || i < at);
        const active = administrative ? i === at : !finished && i === at;
        return (
          <li key={step.key} className="flex min-w-0 flex-1 items-center gap-2">
            <span
              className={cn(
                'grid size-6 shrink-0 place-items-center rounded-full text-xs font-bold',
                done && 'bg-nw-accent text-nw-on-accent',
                active && 'bg-nw-accent text-nw-on-accent ring-4 ring-nw-accent-tint',
                !done && !active && 'bg-nw-neutral-bg text-nw-neutral-text ring-1 ring-nw-border',
              )}
              aria-hidden
            >
              {done ? <Check className="size-3.5" /> : i + 1}
            </span>
            <span className="min-w-0">
              <span className={cn('block truncate text-sm', active ? 'font-bold text-nw-text' : done ? 'font-semibold text-nw-text' : 'text-nw-text-3')}>
                {step.label}
                <span className="sr-only">{done ? ' (done)' : active ? ' (current)' : ''}</span>
              </span>
              {step.sub ? <span className="block truncate text-xs text-nw-text-3">{step.sub}</span> : null}
            </span>
            {i < steps.length - 1 ? <span className="hidden h-px min-w-4 flex-1 bg-nw-border md:block" aria-hidden /> : null}
          </li>
        );
      })}
    </ol>
  );
}

/** Days from Eastern today to a date, said in words: "(1 day)", "(today)", "(2 days overdue)". */
export function DueText({ dueOn, className }: { dueOn: string | null | undefined; className?: string }) {
  if (!dueOn) return <span className={cn('text-nw-text-3', className)}>No due date</span>;
  const today = companyToday();
  const days = Math.round((Date.parse(`${dueOn}T12:00:00Z`) - Date.parse(`${today}T12:00:00Z`)) / 86_400_000);
  const words = days === 0 ? 'today' : days > 0 ? `${days} day${days === 1 ? '' : 's'}` : `${-days} day${days === -1 ? '' : 's'} overdue`;
  return (
    <span className={cn(days < 0 ? 'font-semibold text-nw-urgent-text' : 'text-nw-text', className)}>
      {formatIsoDate(dueOn)} <span className={days < 0 ? '' : 'text-nw-text-3'}>({words})</span>
    </span>
  );
}

export function OwnerCell({ name }: { name: string | null | undefined }) {
  if (!name) return <span className="text-nw-text-3">Unassigned</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-2">
      <Avatar name={name} size="sm" />
      <span className="truncate">{name}</span>
    </span>
  );
}

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return 'Not recorded';
  return formatMoney(cents / 100);
}

/** Label / value rows inside a panel. */
export function FactList({ rows, className }: { rows: [ReactNode, ReactNode][]; className?: string }) {
  return (
    <dl className={cn('grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-x-4 gap-y-2 text-sm', className)}>
      {rows.map(([label, value], i) => (
        <div key={i} className="contents">
          <dt className="text-nw-text-2">{label}</dt>
          <dd className="min-w-0 break-words text-nw-text">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * The next action: what happens next, who owns it, when it is due, and the one button that moves
 * the case on. A refusal from the server is shown as the list of what is missing.
 */
export function NextActionCard({
  action,
  ownerName,
  dueOn,
  onComplete,
  completing,
  completeLabel = 'Mark complete',
  blockers,
  onEdit,
  canWrite,
}: {
  action: string | null;
  ownerName: string | null;
  dueOn: string | null;
  onComplete?: () => void;
  completing?: boolean;
  completeLabel?: string;
  blockers?: string[];
  onEdit?: () => void;
  canWrite: boolean;
}) {
  return (
    <section className="rounded-[10px] border border-nw-done-border bg-nw-accent-tint px-4 py-3" aria-label="Next action">
      {/* The action reads in full on top; owner and due date sit side by side beneath it (owner, 2026-10-13). */}
      <div className="flex items-start gap-3">
        <span className="grid size-10 shrink-0 place-items-center rounded-[9px] bg-nw-panel text-nw-accent-ink" aria-hidden>
          <ClipboardList className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold tracking-[.04em] text-nw-text-2 uppercase">Next action</div>
          <div className="text-[15px] leading-snug font-bold text-nw-text">{action ?? 'Nothing outstanding'}</div>
        </div>
        {canWrite ? (
          <div className="flex shrink-0 gap-2">
            {onEdit ? (
              <Button variant="outline" size="sm" onClick={onEdit}>
                Edit
              </Button>
            ) : null}
            {onComplete && action ? (
              <Button variant="primary" onClick={onComplete} loading={completing}>
                {completeLabel}
              </Button>
            ) : null}
          </div>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 border-t border-nw-done-border/60 pt-3 pl-[52px]">
        <div className="min-w-0">
          <div className="text-xs text-nw-text-2">Owner</div>
          <OwnerCell name={ownerName} />
        </div>
        <div className="min-w-0">
          <div className="text-xs text-nw-text-2">Due date</div>
          <DueText dueOn={dueOn} className="text-sm" />
        </div>
      </div>
      {blockers && blockers.length > 0 ? (
        <ul className="mt-2 list-disc pl-14 text-xs text-nw-warning-text">
          {blockers.map((b) => (
            <li key={b}>{b}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}

/** Owner, next action and due date: the three things every case lets a person set. */
export function WorkEditor({
  open,
  onOpenChange,
  initial,
  onSave,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initial: { ownerId: string | null; nextAction: string | null; nextActionDueOn: string | null };
  onSave: (value: { ownerId: string | null; nextAction: string | null; nextActionDueOn: string | null }) => void;
  saving?: boolean;
}) {
  const people = useSafetyPeople();
  const [ownerId, setOwnerId] = useState(initial.ownerId ?? '');
  const [nextAction, setNextAction] = useState(initial.nextAction ?? '');
  const [due, setDue] = useState(initial.nextActionDueOn ?? '');
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Owner and next action"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" loading={saving} onClick={() => onSave({ ownerId: ownerId || null, nextAction: nextAction.trim() || null, nextActionDueOn: due || null })}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <FormField label="Owner">
          <Select
            value={ownerId}
            onValueChange={setOwnerId}
            placeholder={people.isLoading ? 'Loading…' : 'Choose a person'}
            options={(people.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
          />
        </FormField>
        <FormField label="Next action">
          <Input value={nextAction} onChange={(e) => setNextAction(e.target.value)} maxLength={300} />
        </FormField>
        <FormField label="Due date">
          <DatePicker value={due || null} onIsoChange={setDue} />
        </FormField>
      </div>
    </Modal>
  );
}

/** Asks for a reason, then voids. Nothing in Safety is deleted. */
export function VoidDialog({
  open,
  onOpenChange,
  what,
  onVoid,
  saving,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  what: string;
  onVoid: (reason: string) => void;
  saving?: boolean;
}) {
  const [reason, setReason] = useState('');
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Void ${what}`}
      description="The record is kept, marked void, with your name, the time and this reason. It is not deleted."
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="danger" disabled={reason.trim().length < 5} loading={saving} onClick={() => onVoid(reason.trim())}>
            Void
          </Button>
        </>
      }
    >
      <FormField label="Reason" description="At least 5 characters">
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} />
      </FormField>
    </Modal>
  );
}

const icon = (doc: SafetyDocument) =>
  doc.contentType.startsWith('image/') ? <ImageIcon className="size-4" /> : <FileText className="size-4" />;

/** The case's files: listed, added (upload then link), removed with a reason. */
export function DocumentsCard({
  caseType,
  caseId,
  documents,
  title = 'Documents',
  kinds,
}: {
  caseType: SafetyCaseType;
  caseId: string;
  documents: SafetyDocument[];
  title?: string;
  kinds?: SafetyDocumentKind[];
}) {
  const canWrite = useCan('safety.manage');
  const input = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<SafetyDocumentKind>(kinds?.[0] ?? 'other');
  const attach = useSafetyWrite((file: File) => safetyApi.attach(caseType, caseId, file, kind), 'Document added');
  const remove = useSafetyWrite((id: string) => safetyApi.voidDocument(id, 'Removed from the case file'), 'Document removed');
  return (
    <Card title={title} padding="md">
      {documents.length === 0 ? <p className="text-sm text-nw-text-3">No documents on this case yet.</p> : null}
      <ul className="divide-y divide-nw-border">
        {documents.map((doc) => (
          <li key={doc.id} className="flex items-center gap-3 py-2 text-sm">
            <span className="text-nw-text-3" aria-hidden>
              {icon(doc)}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-semibold text-nw-text">{doc.title}</span>
              <span className="block truncate text-xs text-nw-text-3">
                {doc.fileName} · {Math.max(1, Math.round(doc.sizeBytes / 1024))} KB
              </span>
            </span>
            <span className="text-xs text-nw-text-3">{formatDateTime(doc.uploadedAt)}</span>
            {canWrite ? (
              <button
                type="button"
                aria-label={`Remove ${doc.title}`}
                className="grid size-7 cursor-pointer place-items-center rounded-md text-nw-text-3 hover:bg-nw-hover"
                onClick={() => remove.mutate(doc.id)}
              >
                <Trash2 className="size-3.5" />
              </button>
            ) : null}
          </li>
        ))}
      </ul>
      {canWrite ? (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Select
            size="sm"
            value={kind}
            onValueChange={(v) => setKind(v as SafetyDocumentKind)}
            options={(kinds ?? [...SAFETY_DOCUMENT_KINDS]).map((k) => ({ value: k, label: SAFETY_DOCUMENT_KIND_LABEL[k] }))}
          />
          <input
            ref={input}
            type="file"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) attach.mutate(file);
              e.target.value = '';
            }}
          />
          <Button variant="outline" size="sm" icon={attach.isPending ? <Paperclip /> : <Plus />} loading={attach.isPending} onClick={() => input.current?.click()}>
            Add document
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

/** The case's history, from the audit trail: who did what, when. */
export function TimelineCard({ entries, title = 'Timeline' }: { entries: SafetyTimelineEntry[]; title?: string }) {
  return (
    <Card title={title} padding="md">
      {entries.length === 0 ? <p className="text-sm text-nw-text-3">Nothing recorded yet.</p> : null}
      <ol className="grid gap-2">
        {entries.map((e) => (
          <li key={e.id} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-3 text-sm">
            <span className="mt-1.5 size-2 rounded-full bg-nw-accent" aria-hidden />
            <span className="min-w-0">
              <span className="block text-nw-text">{e.summary}</span>
              <span className="block text-xs text-nw-text-3">
                {e.actorName}
                {e.reason ? ` · ${e.reason}` : ''}
              </span>
            </span>
            <span className="text-right text-xs whitespace-nowrap text-nw-text-3">
              {formatDateTime(e.at)}
            </span>
          </li>
        ))}
      </ol>
    </Card>
  );
}

/** A small "label: value" used inside table cells for the second line. */
export function Sub({ children }: { children: ReactNode }) {
  return <span className="block text-xs text-nw-text-3">{children}</span>;
}

/** A section of a page with a title and an optional right-side note. */
export function Panel({ title, note, actions, children, className, padding = 'md' }: { title?: ReactNode; note?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padding?: 'none' | 'sm' | 'md' }) {
  return (
    <Card title={title} actions={actions ?? (note ? <span className="text-xs text-nw-text-3">{note}</span> : undefined)} padding={padding} className={className}>
      {children}
    </Card>
  );
}

/** Table header cell and cell styles shared by the Safety tables. */
export const th = 'px-3 py-2 text-left text-xs font-semibold text-nw-text-2 whitespace-nowrap';
export const td = 'px-3 py-2.5 align-top text-sm text-nw-text';
