import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Wrench } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  PTI_ISSUE_CATEGORIES,
  PTI_RATINGS,
  PTI_RATING_LABEL,
  conditionsFor,
  dueDateOf,
  listPtiComponents,
  raiseComponentWorkOrder,
  raiseWorkOrder,
  rateComponents,
  stateOf,
  updatePti,
  workOrderStatus,
  type ComponentCondition,
  type PtiIssueCategory,
  type PtiRating,
  type PtiRecord,
  type PtiWindowUnit,
  type RatingEntry,
} from '@/demo';
import {
  Button,
  Checkbox,
  Combobox,
  DatePicker,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { formatIsoDate } from '@/lib/format';
import { weekRangeLabel } from '../pti-week-label';
import { detail } from '../pti-condition-detail';
import { RatingControl } from './PtiCondition';
import { PtiStatusPill } from './PtiStatusPill';

/**
 * The reviewer's workflow, as four numbered steps: what arrived, who watched it and what they
 * decided, what they saw and did, and what shape each component is in.
 *
 * Opened from the header it starts on the **unit** field, because that is what the fleet team has
 * in hand — a unit number off the video that just arrived. Opened from a row the unit is filled and
 * locked. "Save and next" keeps the dialog open on a fresh unit field, so thirty videos are thirty
 * short passes rather than thirty round-trips through the board.
 *
 * The two columns are the point: the paperwork runs down the left in the order it is asked for,
 * and the component table — the long part — gets a column of its own instead of pushing everything
 * else below the fold.
 */

const TODAY = new Date().toISOString().slice(0, 10);

/** The component table: a name column, then the four rating columns, aligned head to row. */
const RATING_GRID = 'grid grid-cols-[minmax(0,1fr)_19rem] items-center gap-3';

export interface PtiReviewDialogProps {
  /** The row to open on, or null to start on the unit field. */
  initial: PtiRecord | null;
  /** Every row of the week, for the unit search. */
  rows: PtiRecord[];
  week: string;
  onClose: () => void;
}

function statusLabel(row: PtiRecord): string {
  return row.status === 'sent' ? 'Sent' : row.status === 'late' ? 'Late' : 'Missing';
}

/** Red on the pill is earned the same way it is on the board: the deadline has gone by. */
function isMissing(row: PtiRecord): boolean {
  return row.status === 'no' && TODAY > dueDateOf(row.weekStart) && stateOf(row) === 'road';
}

export function PtiReviewDialog({ initial, rows, week, onClose }: PtiReviewDialogProps) {
  const [record, setRecord] = useState<PtiRecord | null>(initial);
  const [locked, setLocked] = useState(initial !== null);
  const unitRef = useRef<HTMLButtonElement>(null);

  // The unit field is where the hands are: focus it when it is the thing to fill.
  useEffect(() => {
    if (locked || record !== null) return;
    // After the dialog's own focus move, which lands on the close button first.
    const handle = window.setTimeout(() => unitRef.current?.focus(), 0);
    return () => window.clearTimeout(handle);
  }, [locked, record]);

  const options = useMemo(
    () =>
      rows
        .filter((row) => stateOf(row) !== 'inactive')
        .sort((a, b) => a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }))
        .map((row) => ({
          value: row.id,
          label: row.unitNumber,
          description: `${(row.driverName ?? 'No driver').toUpperCase()}${
            row.dispatcherName ? ` · ${row.dispatcherName}` : ''
          } · ${statusLabel(row)}`,
        })),
    [rows],
  );

  const title = record
    ? `Unit ${record.unitNumber} — ${weekRangeLabel(record.weekStart)}`
    : `Update PTI — ${weekRangeLabel(week)}`;

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="lg"
      className="max-w-[68rem]"
      title={title}
      // Once a unit is chosen the strip below carries the driver and the dispatcher; saying it
      // twice in two type sizes is noise.
      description={record ? undefined : 'Pick the unit off the video, then record what it showed.'}
      footer={
        record ? undefined : (
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-4">
        {/* The unit strip: which truck, how it stands, and the way back to the picker. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-[10px] border border-line-soft bg-nw-subtle px-4 py-3">
          {locked && record ? (
            <>
              <span className="text-sm font-semibold text-ink">Unit {record.unitNumber}</span>
              <span className="text-xs text-nw-text-3">
                {(record.driverName ?? 'No driver').toUpperCase()}
                {record.dispatcherName ? ` · ${record.dispatcherName}` : ''}
              </span>
              <PtiStatusPill status={record.status} missing={isMissing(record)} />
              <button
                type="button"
                className="ml-auto text-xs text-primary-text hover:underline"
                onClick={() => setLocked(false)}
              >
                Change unit
              </button>
            </>
          ) : (
            <div className="w-full">
              <FormField
                label="Unit"
                description="Unit number, driver or dispatcher; the status shows what still needs filing."
              >
                <Combobox
                  ref={unitRef}
                  aria-label="Unit"
                  options={options}
                  value={record?.id ?? null}
                  onValueChange={(id) => {
                    const next = id ? (rows.find((row) => row.id === id) ?? null) : null;
                    setRecord(next);
                    if (next) setLocked(true);
                  }}
                  placeholder="Type a unit number, driver or dispatcher…"
                  searchPlaceholder="Unit, driver or dispatcher"
                  emptyMessage="No eligible unit matches this week"
                />
              </FormField>
            </div>
          )}
        </div>

        {record ? (
          <ReviewForm
            key={record.id}
            record={record}
            onSaved={(next) => {
              if (next === 'close') onClose();
              else {
                setRecord(null);
                setLocked(false);
              }
            }}
            onCancel={onClose}
          />
        ) : null}
      </div>
    </Modal>
  );
}

/** One numbered step of the panel. The numeral is decoration; the heading is the name. */
function Step({
  n,
  title,
  hint,
  children,
  className,
}: {
  n: number;
  title: string;
  hint?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        'flex flex-col gap-3 rounded-[10px] border border-line-soft bg-surface p-4',
        className,
      )}
    >
      <header className="flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-nw-accent-tint text-2xs font-bold text-nw-accent-ink"
        >
          {n}
        </span>
        <span className="flex min-w-0 flex-col">
          <h3 className="text-md font-bold text-ink">{title}</h3>
          {hint ? <p className="text-xs text-muted">{hint}</p> : null}
        </span>
      </header>
      {children}
    </section>
  );
}

interface RatingDraft {
  rating: PtiRating | null;
  windowValue: string;
  windowUnit: PtiWindowUnit;
}

function ReviewForm({
  record,
  onSaved,
  onCancel,
}: {
  record: PtiRecord;
  onSaved: (mode: 'close' | 'next') => void;
  onCancel: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const account = useAccount();

  const [status, setStatus] = useState(record.status);
  const [sentDate, setSentDate] = useState(record.sentDate ?? TODAY);
  const [checkedDate, setCheckedDate] = useState(record.checkedDate ?? TODAY);
  const [result, setResult] = useState(record.result);
  const [category, setCategory] = useState<string>(record.issueCategory ?? '');
  const [issueNote, setIssueNote] = useState(record.issueNote ?? '');
  const [actionTaken, setActionTaken] = useState(record.actionTaken ?? '');
  /*
   * Closing a finding without a repair is a decision, not a note (acceptance test A22).
   *
   * "Action taken" used to close a finding the moment anybody typed in it: "will look at it",
   * "driver says it's fine". Unit 2718's slack adjuster sat that way, marked "Nothing yet", with
   * the truck showing Available. So a finding is closed by a work order, or by ticking this and
   * saying why - and the name and time go on the record with it.
   */
  const [noRepair, setNoRepair] = useState(record.noRepairNeeded != null);
  const [noRepairReason, setNoRepairReason] = useState(record.noRepairNeeded?.reason ?? '');
  const [error, setError] = useState<string | null>(null);

  // What the components looked like coming into this review, and what this week already said.
  const conditions = useMemo(() => conditionsFor(record.truckId, record.weekStart), [record]);
  const components = useMemo(
    () => listPtiComponents().filter((c) => conditions.some((x) => x.component.id === c.id)),
    [conditions],
  );
  const [drafts, setDrafts] = useState<Record<string, RatingDraft>>(() => {
    const out: Record<string, RatingDraft> = {};
    for (const condition of conditions) {
      const thisWeek = condition.source?.recordId === record.id ? condition.source : null;
      out[condition.component.id] = {
        rating: thisWeek?.rating ?? null,
        windowValue:
          thisWeek?.windowValue !== null && thisWeek?.windowValue !== undefined
            ? String(thisWeek.windowValue)
            : '',
        windowUnit: thisWeek?.windowUnit ?? 'weeks',
      };
    }
    return out;
  });

  function setDraft(id: string, patch: Partial<RatingDraft>) {
    setDrafts((current) => ({ ...current, [id]: { ...(current[id] as RatingDraft), ...patch } }));
  }

  /** Ratings that are new this session: a value this week's rows do not already carry. */
  function newEntries(): RatingEntry[] {
    const entries: RatingEntry[] = [];
    for (const condition of conditions) {
      const draft = drafts[condition.component.id];
      if (!draft?.rating) continue;
      const thisWeek = condition.source?.recordId === record.id ? condition.source : null;
      const windowValue =
        draft.rating === 'replace_soon'
          ? Number(draft.windowValue.replace(/,/g, '')) || null
          : null;
      const windowUnit = draft.rating === 'replace_soon' ? draft.windowUnit : null;
      if (
        thisWeek &&
        thisWeek.rating === draft.rating &&
        thisWeek.windowValue === windowValue &&
        thisWeek.windowUnit === windowUnit
      ) {
        continue;
      }
      entries.push({
        componentId: condition.component.id,
        rating: draft.rating,
        windowValue,
        windowUnit,
      });
    }
    return entries;
  }

  async function persist(): Promise<void> {
    if (!account) throw new Error('Your session has ended. Sign in again to record this.');
    const by = { id: account.userId, name: account.name };
    await updatePti(record.id, {
      status,
      sentDate: status === 'no' ? null : sentDate || null,
      checkedBy: by,
      checkedDate: result === 'pending' ? null : checkedDate || null,
      result,
      issueCategory:
        result === 'issue_found' ? ((category || null) as PtiIssueCategory | null) : null,
      issueNote: result === 'issue_found' ? issueNote.trim() || null : null,
      actionTaken: actionTaken.trim() || null,
      noRepairNeeded:
        result === 'issue_found' && noRepair && noRepairReason.trim()
          ? {
              reason: noRepairReason.trim(),
              byId: by.id,
              byName: by.name,
              at: new Date().toISOString(),
            }
          : null,
    });
    const entries = newEntries();
    if (entries.length > 0) await rateComponents(record.id, entries, by);
    await queryClient.invalidateQueries({ queryKey: ['pti'] });
    await queryClient.invalidateQueries({ queryKey: ['fleet'] });
  }

  const save = useMutation({
    mutationFn: async (mode: 'close' | 'next') => {
      await persist();
      return mode;
    },
    onSuccess: (mode) => {
      toast({ tone: 'success', title: `Unit ${record.unitNumber} updated` });
      onSaved(mode);
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'That could not be saved'),
  });

  const issueOrder = useMutation({
    mutationFn: async () => {
      await persist();
      return raiseWorkOrder(record.id);
    },
    onSuccess: async (row) => {
      await queryClient.invalidateQueries({ queryKey: ['pti'] });
      toast({
        tone: 'success',
        title: `Work order ${row.workOrderNumber} opened`,
        description: `Unit ${row.unitNumber} · ${row.issueCategory ?? 'issue'} — the shop has it now.`,
      });
      onSaved('close');
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'The work order could not be opened'),
  });

  const componentOrder = useMutation({
    mutationFn: async (componentId: string) => {
      if (!account) throw new Error('Your session has ended. Sign in again to record this.');
      await persist();
      return raiseComponentWorkOrder(record.truckId, componentId, {
        id: account.userId,
        name: account.name,
      });
    },
    onSuccess: async ({ order }, componentId) => {
      await queryClient.invalidateQueries({ queryKey: ['pti'] });
      const name = components.find((c) => c.id === componentId)?.name ?? 'component';
      toast({
        tone: 'success',
        title: `Work order ${order.roNumber} opened`,
        description: `${name} on unit ${record.unitNumber} — the shop has it now.`,
      });
      onSaved('close');
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'The work order could not be opened'),
  });

  const busy = save.isPending || issueOrder.isPending || componentOrder.isPending;

  return (
    <>
      {error ? (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}

      <p className="text-xs text-nw-text-3">
        {record.checkedByName
          ? `Recorded as checked by ${record.checkedByName}${
              record.checkedDate ? ` on ${formatIsoDate(record.checkedDate)}` : ''
            }.`
          : 'Nobody has reviewed this inspection yet.'}
      </p>

      <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
        <div className="flex flex-col gap-4">
          <Step n={1} title="Receipt" hint="Whether the walk-around arrived, and when.">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <FormField label="Status">
                <Select
                  options={[
                    { value: 'sent', label: 'Sent' },
                    { value: 'late', label: 'Late' },
                    { value: 'no', label: 'Never sent' },
                  ]}
                  value={status}
                  onValueChange={(value) => setStatus(value as PtiRecord['status'])}
                />
              </FormField>
              <FormField label="Sent date">
                <DatePicker
                  value={status === 'no' ? '' : sentDate}
                  disabled={status === 'no'}
                  onIsoChange={(event) => setSentDate(event)}
                />
              </FormField>
            </div>
          </Step>

          <Step n={2} title="Review" hint="What the reviewer decided, and when they watched it.">
            <div className="grid grid-cols-1 gap-x-4 gap-y-3 sm:grid-cols-2">
              <FormField label="Result">
                <Select
                  options={[
                    { value: 'pending', label: 'NOT REVIEWED YET' },
                    { value: 'no_issues', label: 'NO ISSUES' },
                    { value: 'issue_found', label: 'ISSUE FOUND' },
                  ]}
                  value={result}
                  onValueChange={(value) => setResult(value as PtiRecord['result'])}
                />
              </FormField>
              <FormField label="Checked date">
                <DatePicker
                  value={result === 'pending' ? '' : checkedDate}
                  disabled={result === 'pending'}
                  onIsoChange={(event) => setCheckedDate(event)}
                />
              </FormField>
              <FormField label="Updated by">
                <p className="flex h-(--control-height-md) items-center px-3 text-sm text-ink">
                  {account ? account.name : <span className="text-danger-text">Signed out</span>}
                </p>
              </FormField>
            </div>
          </Step>

          <Step
            n={3}
            title="Issue & action"
            hint="An issue with no action is flagged on the board and chased until it is filled."
          >
            <div className="flex flex-col gap-3">
              {result === 'issue_found' ? (
                <>
                  <FormField label="Category">
                    <Select
                      options={[
                        { value: '', label: 'Choose one' },
                        ...PTI_ISSUE_CATEGORIES.map((value) => ({ value, label: value })),
                      ]}
                      value={category}
                      onValueChange={setCategory}
                    />
                  </FormField>
                  <FormField label="Issue found" description="What the reviewer saw on the video.">
                    <Textarea
                      rows={2}
                      value={issueNote}
                      onChange={(event) => setIssueNote(event.target.value)}
                    />
                  </FormField>
                </>
              ) : null}
              <FormField label="Action taken" description="What was done about it, in one line.">
                <Textarea
                  rows={2}
                  value={actionTaken}
                  onChange={(event) => setActionTaken(event.target.value)}
                  placeholder="Booked into the yard on the next reset"
                />
              </FormField>
              {result === 'issue_found' && !record.workOrderId ? (
                <div className="flex flex-col gap-2 rounded-lg border border-line-soft p-3">
                  <Checkbox
                    checked={noRepair}
                    onCheckedChange={(checked) => setNoRepair(checked === true)}
                    label="No repair needed"
                    description="The finding stays on the board until a work order is opened or somebody decides this, by name."
                  />
                  {noRepair ? (
                    <FormField label="Why no repair is needed" required>
                      <Textarea
                        rows={2}
                        value={noRepairReason}
                        onChange={(event) => setNoRepairReason(event.target.value)}
                        placeholder="Within tolerance on re-measure; photographed and filed"
                      />
                    </FormField>
                  ) : null}
                </div>
              ) : null}
              {record.workOrderNumber ? (
                <p className="text-xs text-muted">
                  On work order {record.workOrderNumber}
                  {workOrderStatus(record)
                    ? ` · ${workOrderStatus(record)?.replace(/_/g, ' ')}`
                    : ''}
                  .
                </p>
              ) : null}
            </div>
          </Step>
        </div>

        <Step
          n={4}
          title="Condition"
          hint="One row per component. Leave a part unrated if it was not visible; its last rating carries forward."
        >
          {result === 'pending' ? (
            <p className="text-xs text-muted">
              Set a result above and the component table opens here.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <div className={cn(RATING_GRID, 'pb-1')}>
                <span className="eyebrow">Component</span>
                <div className="grid grid-cols-4 gap-1">
                  {PTI_RATINGS.map((rating) => (
                    <span
                      key={rating}
                      className="text-center text-2xs leading-tight font-semibold text-nw-text-3"
                    >
                      {PTI_RATING_LABEL[rating]}
                    </span>
                  ))}
                </div>
              </div>
              {components.map((component) => {
                const condition = conditions.find(
                  (c) => c.component.id === component.id,
                ) as ComponentCondition;
                const draft = drafts[component.id] as RatingDraft;
                return (
                  <div
                    key={component.id}
                    className="border-t border-line-soft py-2 first:border-t-0 first:pt-0"
                  >
                    <div className={RATING_GRID}>
                      <div className="flex min-w-0 flex-col">
                        <span className="text-sm font-medium text-ink">{component.name}</span>
                        <span className="text-xs text-muted">
                          {condition.rating && condition.source?.recordId !== record.id
                            ? `Last: ${PTI_RATING_LABEL[condition.rating]}${detail(condition, TODAY) ? ` · ${detail(condition, TODAY)}` : ''}`
                            : component.defaultLifeHint
                              ? `Usually ${component.defaultLifeHint}`
                              : 'Not rated before'}
                        </span>
                      </div>
                      <RatingControl
                        label={component.name}
                        value={draft.rating}
                        disabled={busy}
                        onChange={(rating) => setDraft(component.id, { rating })}
                      />
                    </div>
                    {draft.rating === 'replace_soon' ? (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className="text-xs text-secondary">Expected window</span>
                        <Input
                          aria-label={`${component.name} expected window`}
                          inputMode="numeric"
                          className="w-24"
                          size="sm"
                          value={draft.windowValue}
                          onChange={(event) =>
                            setDraft(component.id, { windowValue: event.target.value })
                          }
                          placeholder={draft.windowUnit === 'weeks' ? '2' : '8,000'}
                        />
                        <Select
                          aria-label={`${component.name} window unit`}
                          size="sm"
                          className="w-28"
                          options={[
                            { value: 'weeks', label: 'weeks' },
                            { value: 'miles', label: 'miles' },
                          ]}
                          value={draft.windowUnit}
                          onValueChange={(value) =>
                            setDraft(component.id, { windowUnit: value as PtiWindowUnit })
                          }
                        />
                      </div>
                    ) : null}
                    {draft.rating === 'replace_now' ? (
                      <div className="mt-2">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Wrench />}
                          loading={
                            componentOrder.isPending && componentOrder.variables === component.id
                          }
                          disabled={busy}
                          onClick={() => {
                            setError(null);
                            componentOrder.mutate(component.id);
                          }}
                        >
                          Open a work order for {component.name.toLowerCase()}
                        </Button>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </Step>
      </div>

      {/* Pinned to the bottom of the dialog: the actions are the same whatever is scrolled. */}
      <div className="sticky -bottom-5 -mx-1 -mb-5 flex flex-wrap items-center justify-end gap-2 border-t border-line bg-surface px-1 pt-3 pb-5">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
        {result === 'issue_found' && !record.workOrderId ? (
          <Button
            variant="secondary"
            icon={<Wrench />}
            loading={issueOrder.isPending}
            disabled={busy}
            onClick={() => {
              setError(null);
              issueOrder.mutate();
            }}
          >
            Open a work order
          </Button>
        ) : null}
        <Button
          variant="secondary"
          loading={save.isPending && save.variables === 'next'}
          disabled={busy}
          onClick={() => {
            setError(null);
            save.mutate('next');
          }}
        >
          Save and next
        </Button>
        <Button
          loading={save.isPending && save.variables === 'close'}
          disabled={busy}
          onClick={() => {
            setError(null);
            save.mutate('close');
          }}
        >
          Save
        </Button>
      </div>
    </>
  );
}
