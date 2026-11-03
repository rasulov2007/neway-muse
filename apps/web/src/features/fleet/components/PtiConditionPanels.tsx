import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ClipboardList, ExternalLink, Wrench } from 'lucide-react';
import { useState } from 'react';
import {
  PTI_RATING_LABEL,
  conditionCandidates,
  conditionQueue,
  conditionsFor,
  listPtiComponents,
  ptiConditionConfig,
  raiseComponentWorkOrder,
  savePtiComponent,
  setPtiConditionConfig,
  windowClosed,
  type ConditionQueueItem,
  type PtiComponentDef,
} from '@/demo';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  FormField,
  Input,
  Switch,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { today } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { detail } from '../pti-condition-detail';
import { ConditionPill } from './PtiCondition';

/**
 * Where the condition ratings go besides the board: the truck page, the maintenance queue, the
 * spend dashboard and the catalog in Settings. All of them read the same rows the board writes.
 */

/** Whole days from an ISO date to today, on the server's clock. */
function ageDays(date: string): number {
  return Math.max(
    0,
    Math.round((Date.parse(`${today()}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000),
  );
}

function useRaiseComponentOrder() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const account = useAccount();
  return useMutation({
    mutationFn: ({ truckId, componentId }: { truckId: string; componentId: string }) => {
      if (!account) throw new Error('Your session has ended. Sign in again to record this.');
      return raiseComponentWorkOrder(truckId, componentId, {
        id: account.userId,
        name: account.name,
      });
    },
    onSuccess: async ({ order }) => {
      await queryClient.invalidateQueries({ queryKey: ['pti'] });
      await queryClient.invalidateQueries({ queryKey: ['fleet'] });
      toast({
        tone: 'success',
        title: `Work order ${order.roNumber} opened`,
        description: order.summary,
      });
    },
    onError: (err: unknown) =>
      toast({
        tone: 'danger',
        title: 'The work order could not be opened',
        description: err instanceof Error ? err.message : undefined,
      }),
  });
}

/** "What shape is 0069 in?" — every component's current rating, when, and its window. */
export function TruckConditionCard({ truckId }: { truckId: string }) {
  return (
    <Card
      title="Condition"
      description="From the weekly walk-around video. A rating carries forward until the component is rated again."
    >
      <TruckConditionList truckId={truckId} />
    </Card>
  );
}

/**
 * The condition rows without a card around them, so a page can put them inside its own section.
 * Empty until the PTI board has rated something: the ratings are recorded there, never here.
 */
export function TruckConditionList({ truckId }: { truckId: string }) {
  const query = useQuery({
    queryKey: ['pti', 'condition', truckId],
    queryFn: () => conditionsFor(truckId),
  });
  const raise = useRaiseComponentOrder();
  const conditions = query.data ?? [];
  const rated = conditions.filter((c) => c.rating !== null);
  const TODAY = today();

  return (
    <>
      {rated.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<ClipboardList />}
          title="No components rated yet"
          description="Review weekly walk-around videos on the PTI board."
          action={
            <Button variant="secondary" size="sm" asChild>
              {/* Lands on this unit's review, not on whichever row the board lists first. */}
              <Link to="/fleet/pti" search={{ review: truckId }}>
                <ExternalLink aria-hidden />
                Open PTI board
              </Link>
            </Button>
          }
        />
      ) : (
        <ul className="divide-y divide-line-soft">
          {conditions.map((c) => (
            <li
              key={c.component.id}
              className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
            >
              <span className="flex min-w-0 flex-col">
                <span className="font-medium text-ink">{c.component.name}</span>
                <span className="text-xs text-muted">
                  {c.source
                    ? c.carriedOver
                      ? // A rating from an earlier week says so first, with its true age: nobody
                        // watched this component this week, and the row must not read as if they had.
                        `Carried forward · ${ageDays(c.source.ratedAt.slice(0, 10))} days old · rated ${formatIsoDate(c.source.ratedAt.slice(0, 10))}${c.source.ratedByName ? ` by ${c.source.ratedByName}` : ''}${detail(c, TODAY) ? ` · ${detail(c, TODAY)}` : ''}${c.source.note ? ` · ${c.source.note}` : ''}`
                      : `Rated ${formatIsoDate(c.source.ratedAt.slice(0, 10))}${c.source.ratedByName ? ` by ${c.source.ratedByName}` : ''}${detail(c, TODAY) ? ` · ${detail(c, TODAY)}` : ''}${c.source.note ? ` · ${c.source.note}` : ''}`
                    : 'Not rated'}
                </span>
              </span>
              <span className="flex items-center gap-2">
                {c.rating ? (
                  <ConditionPill rating={c.rating} demoted={c.carriedOver} />
                ) : (
                  <span className="text-faint">—</span>
                )}
                {(c.rating === 'replace_now' || windowClosed(c, TODAY)) &&
                !c.source?.workOrderId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Wrench />}
                    loading={raise.isPending && raise.variables?.componentId === c.component.id}
                    onClick={() => raise.mutate({ truckId, componentId: c.component.id })}
                  >
                    Work order
                  </Button>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

/** Maintenance planning: components the video said need the shop, not yet on an open order. */
export function ConditionQueuePanel() {
  const TODAY = today();
  const query = useQuery({ queryKey: ['pti', 'condition-queue'], queryFn: () => conditionQueue() });
  const raise = useRaiseComponentOrder();
  const items = query.data ?? [];
  if (items.length === 0) return null;
  return (
    <Card
      title="From the walk-around videos"
      description={`${items.length} component${items.length === 1 ? '' : 's'} rated Replace now, or Replace soon past its window, with no open work order.`}
    >
      <ul className="divide-y divide-line-soft">
        {items.map((item: ConditionQueueItem) => (
          <li
            key={`${item.truckId}:${item.condition.component.id}`}
            className="flex flex-wrap items-center justify-between gap-3 py-2 text-sm"
          >
            <span className="flex min-w-0 flex-col">
              <span className="flex items-center gap-2">
                <Link
                  to="/fleet/trucks/$truckId"
                  params={{ truckId: item.truckId }}
                  className="font-medium text-primary-text hover:underline"
                >
                  Unit {item.unitNumber}
                </Link>
                <span className="text-ink">{item.condition.component.name}</span>
                {item.condition.rating ? <ConditionPill rating={item.condition.rating} /> : null}
              </span>
              <span className="text-xs text-muted">
                {item.reason === 'window_closed' ? 'Window closed · ' : ''}
                {detail(item.condition, TODAY)}
                {item.condition.source
                  ? ` · PTI video, week of ${formatIsoDate(item.condition.source.weekStart)}`
                  : ''}
              </span>
            </span>
            <Button
              size="sm"
              variant="secondary"
              icon={<Wrench />}
              loading={
                raise.isPending &&
                raise.variables?.truckId === item.truckId &&
                raise.variables?.componentId === item.condition.component.id
              }
              onClick={() =>
                raise.mutate({ truckId: item.truckId, componentId: item.condition.component.id })
              }
            >
              Open work order
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Upcoming spend, visible before it lands: units with a component in Replace soon or Replace now. */
export function ConditionCandidatesCard() {
  const query = useQuery({
    queryKey: ['pti', 'condition-candidates'],
    queryFn: () => conditionCandidates(),
  });
  const data = query.data;
  return (
    <Card
      title="Condition candidates"
      description="Units whose walk-around video rated a component Replace soon or Replace now — spend that has not been booked yet."
    >
      {!data ? (
        <div className="h-12 animate-pulse rounded bg-surface-muted" />
      ) : data.units === 0 ? (
        <p className="text-sm text-muted">
          No component is currently rated Replace soon or Replace now.
        </p>
      ) : (
        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
          <span className="flex items-baseline gap-2">
            <span className="tabular text-2xl font-semibold text-ink">{data.units}</span>
            <span className="text-xs text-secondary">units</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="tabular text-lg font-semibold text-danger-text">
              {data.replaceNow}
            </span>
            <span className="text-xs text-secondary">Replace now</span>
          </span>
          <span className="flex items-baseline gap-2">
            <span className="tabular text-lg font-semibold text-warning-text">
              {data.replaceSoon}
            </span>
            <span className="text-xs text-secondary">Replace soon</span>
          </span>
          <Link to="/fleet/pti" className="ml-auto text-sm text-primary-text hover:underline">
            Open the PTI board
          </Link>
        </div>
      )}
    </Card>
  );
}

/**
 * The chips the issue card offers for a component ("Out of stroke", "Marker lamp dark"): a
 * comma-separated line, saved when it is left. Configuration, not code (brief §6.3).
 */
function QuickPicksField({
  component,
  canEdit,
  onSave,
}: {
  component: PtiComponentDef;
  canEdit: boolean;
  onSave: (quickPicks: string[]) => void;
}) {
  const current = (component.quickPicks ?? []).join(', ');
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const next = draft
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);
    setDraft(null);
    if (next.join(', ') !== current) onSave(next);
  };
  if (!canEdit) {
    return <span className="block text-xs text-muted">Quick picks: {current || 'none'}</span>;
  }
  return (
    <Input
      size="sm"
      className="mt-1 w-full max-w-md"
      aria-label={`${component.name} quick picks`}
      value={draft ?? current}
      placeholder="Quick picks, comma-separated: Out of stroke, Lining worn"
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
    />
  );
}

/** Admin → Settings: the components a walk-around rates, and the carry-over rule. */
export function PtiComponentCatalogCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ['pti', 'catalog'],
    queryFn: () => ({ components: listPtiComponents(true), config: ptiConditionConfig() }),
  });
  const [draftName, setDraftName] = useState('');
  const [draftHint, setDraftHint] = useState('');
  const [stale, setStale] = useState<string | null>(null);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['pti'] });
  const save = useMutation({
    mutationFn: (input: Parameters<typeof savePtiComponent>[0]) => savePtiComponent(input),
    onSuccess: async () => {
      await invalidate();
      setDraftName('');
      setDraftHint('');
    },
    onError: (err: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not saved',
        description: err instanceof Error ? err.message : undefined,
      }),
  });
  const saveConfig = useMutation({
    mutationFn: (weeks: number) => setPtiConditionConfig({ staleAfterWeeks: weeks }),
    onSuccess: async () => {
      await invalidate();
      setStale(null);
      toast({ tone: 'success', title: 'Carry-over rule saved' });
    },
    onError: (err: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not saved',
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  const components = catalog.data?.components ?? [];
  const config = catalog.data?.config;

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-md font-bold text-ink">Walk-around components</h2>
        <p className="text-xs text-muted">
          What the PTI reviewer rates on each video. Ratings keep their component when it is
          renamed; an inactive component stops being offered but keeps its history.
        </p>
      </div>
      <ul className="divide-y divide-line-soft rounded-lg border border-line">
        {components.map((c: PtiComponentDef) => (
          <li key={c.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium text-ink">{c.name}</span>
              {c.trailerOnly ? (
                <Badge tone="neutral" variant="outline" size="sm" className="ml-2">
                  Trailer only
                </Badge>
              ) : null}
              <span className="block text-xs text-muted">
                {c.defaultLifeHint ? `Usually ${c.defaultLifeHint}` : 'No expected-life hint'}
              </span>
              <QuickPicksField
                component={c}
                canEdit={canEdit && !save.isPending}
                onSave={(quickPicks) =>
                  save.mutate({
                    id: c.id,
                    name: c.name,
                    defaultLifeHint: c.defaultLifeHint,
                    trailerOnly: c.trailerOnly,
                    active: c.active,
                    quickPicks,
                  })
                }
              />
            </span>
            <label className="flex items-center gap-2 text-xs text-secondary">
              Active
              <Switch
                aria-label={`${c.name} active`}
                checked={c.active}
                disabled={!canEdit || save.isPending}
                onCheckedChange={(active) =>
                  save.mutate({
                    id: c.id,
                    name: c.name,
                    defaultLifeHint: c.defaultLifeHint,
                    trailerOnly: c.trailerOnly,
                    active,
                  })
                }
              />
            </label>
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-end">
          <FormField label="New component">
            <Input
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              placeholder="Exhaust / DPF"
            />
          </FormField>
          <FormField label="Expected life (optional)">
            <Input
              value={draftHint}
              onChange={(e) => setDraftHint(e.target.value)}
              placeholder="100k miles"
            />
          </FormField>
          <Button
            variant="secondary"
            loading={save.isPending}
            disabled={!draftName.trim()}
            onClick={() =>
              save.mutate({
                name: draftName,
                defaultLifeHint: draftHint || null,
                active: true,
                trailerOnly: false,
              })
            }
          >
            Add component
          </Button>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <FormField
          label="Flag a carried-over rating for re-check after"
          description="A rating nobody has refreshed for this many weeks is marked “re-check” on the board rather than silently kept."
        >
          <Input
            inputMode="numeric"
            className="w-32"
            value={stale ?? String(config?.staleAfterWeeks ?? '')}
            disabled={!canEdit}
            onChange={(e) => setStale(e.target.value)}
            aria-label="Weeks before re-check"
          />
        </FormField>
        {canEdit ? (
          <Button
            variant="secondary"
            loading={saveConfig.isPending}
            disabled={stale === null}
            onClick={() => saveConfig.mutate(Number(stale))}
          >
            Save weeks
          </Button>
        ) : null}
      </div>
      <p className="text-xs text-faint">
        Ratings: {Object.values(PTI_RATING_LABEL).join(' · ')}. Stored per PTI record per component,
        append-only.
      </p>
    </Card>
  );
}
