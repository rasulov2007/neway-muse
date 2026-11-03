import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { ROUTE_OPTION_TAG_LABELS, type RouteOption, type RouteOptionTag } from '@neway/shared';
import { chooseLoadRoute, fetchRouteOptions, loadWriteMessage, type Load } from '@/demo';
import { Alert, Badge, Button, cn, type BadgeTone } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { formatMoney } from '@/lib/format';

/**
 * Route options after Create load (owner, 2026-10-27): up to three roads from TollGuru with
 * tolls and fuel, cheapest first. The dispatcher picks one (the cheapest is selected) and it
 * goes into the driver's Telegram message. TollGuru failing is said plainly and never blocks:
 * Skip goes on without a route.
 */
const TAG_TONE: Record<RouteOptionTag, BadgeTone> = {
  cheapest: 'success',
  fastest: 'info',
  least_fuel: 'neutral',
  shortest: 'neutral',
};

export function durationText(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

const money = (n: number) => formatMoney(n);

/** What TollGuru's failure means to the dispatcher; the server already worded it. */
export function routeOptionsError(error: unknown): { code: string | null; message: string } {
  if (error instanceof ApiError) {
    const code = (error.problem as { code?: unknown } | null)?.code;
    return { code: typeof code === 'string' ? code : null, message: error.title || error.message };
  }
  return { code: null, message: error instanceof Error ? error.message : 'TollGuru did not answer.' };
}

export function RouteOptionsPanel({
  load,
  onChosen,
  onSkip,
  skipLabel = 'Skip',
}: {
  load: Load;
  onChosen: (load: Load) => void;
  onSkip?: () => void;
  skipLabel?: string;
}) {
  const queryClient = useQueryClient();
  const [refresh, setRefresh] = useState(0);
  const options = useQuery({
    queryKey: ['load-route-options', load.id, refresh],
    queryFn: () => fetchRouteOptions(load.id, refresh > 0),
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const [picked, setPicked] = useState<string | null>(null);
  const list = options.data?.options ?? [];
  const selected = picked ?? load.route?.optionId ?? list[0]?.id ?? null;

  const choose = useMutation({
    mutationFn: (optionId: string) => chooseLoadRoute(load.id, optionId),
    onSuccess: async (updated) => {
      await queryClient.invalidateQueries({ queryKey: ['load'] });
      onChosen(updated);
    },
  });

  const failure = options.error ? routeOptionsError(options.error) : null;

  return (
    <section aria-label="Route options" className="flex flex-col gap-2.5 rounded-[10px] border border-nw-border bg-nw-panel p-3" data-testid="route-options">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-ink">Route options</h3>
          <p className="text-xs text-muted">From TollGuru for a loaded 5-axle truck: tolls and fuel for each road. Pick one for the driver’s message.</p>
        </div>
        {options.data ? (
          <Button size="sm" variant="ghost" icon={<RefreshCw />} onClick={() => setRefresh((n) => n + 1)} disabled={options.isFetching}>
            Ask again
          </Button>
        ) : null}
      </div>

      {options.isPending ? (
        <p className="text-sm text-muted" role="status">Loading…</p>
      ) : failure ? (
        <Alert tone={failure.code === 'unavailable' ? 'danger' : 'warning'} title={failure.message} data-testid="route-options-error">
          The load is booked either way. {failure.code === 'unavailable' ? 'Try again, or skip and send the message without a route.' : 'Skip and send the message without a route.'}
        </Alert>
      ) : (
        <div role="radiogroup" aria-label="Routes" className="flex flex-col gap-1.5">
          {list.map((o) => (
            <RouteRow key={o.id} option={o} checked={o.id === selected} onSelect={() => setPicked(o.id)} />
          ))}
        </div>
      )}

      {choose.error ? (
        <p role="alert" className="text-sm text-danger-text">
          {loadWriteMessage(choose.error, 'The route was not saved.')}
        </p>
      ) : null}

      <div className="flex flex-wrap justify-end gap-2">
        {failure ? (
          <Button size="sm" variant="secondary" icon={<RefreshCw />} onClick={() => setRefresh((n) => n + 1)} loading={options.isFetching}>
            Try again
          </Button>
        ) : null}
        {onSkip ? (
          <Button size="sm" variant="ghost" onClick={onSkip}>
            {skipLabel}
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="primary"
          disabled={!selected || list.length === 0 || Boolean(failure)}
          loading={choose.isPending}
          onClick={() => selected && choose.mutate(selected)}
          data-testid="use-route"
        >
          Use this route
        </Button>
      </div>
    </section>
  );
}

function RouteRow({ option: o, checked, onSelect }: { option: RouteOption; checked: boolean; onSelect: () => void }) {
  const tolls = o.hasTolls || o.tollCost > 0 ? `Tolls ${money(o.tollCost)}` : 'No tolls';
  const cash = o.cashTollCost !== null && o.cashTollCost !== o.tollCost ? ` (cash ${money(o.cashTollCost)})` : '';
  return (
    <div
      role="radio"
      aria-checked={checked}
      aria-label={`${o.via}, ${o.miles} miles, total ${money(o.totalCost)}`}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        'flex cursor-pointer gap-2.5 rounded-[8px] border px-3 py-2 text-sm',
        checked ? 'border-primary bg-primary-soft' : 'border-nw-border bg-surface hover:bg-nw-hover',
      )}
      data-testid="route-option"
    >
      <span aria-hidden className={cn('mt-1 inline-block size-3.5 shrink-0 rounded-full border-2', checked ? 'border-primary bg-primary' : 'border-nw-border-strong')} />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="font-semibold text-ink">{o.via}</span>
            {o.tags.map((t) => (
              <Badge key={t} tone={TAG_TONE[t]} dot size="sm">
                {ROUTE_OPTION_TAG_LABELS[t]}
              </Badge>
            ))}
          </span>
          <span className="tabular-nums text-ink">
            <span className="font-bold">{money(o.totalCost)}</span> <span className="text-xs text-muted">total</span>
          </span>
        </div>
        <p className="flex flex-wrap items-center gap-x-2 text-xs tabular-nums text-muted">
          <span>{o.miles.toLocaleString('en-US')} mi</span>
          <span aria-hidden>·</span>
          <span>{durationText(o.durationMinutes)}</span>
          <span aria-hidden>·</span>
          <span>
            {tolls}
            {cash}
          </span>
          <span aria-hidden>·</span>
          <span>Fuel {money(o.fuelCost)}</span>
          {o.mapUrl ? (
            <a href={o.mapUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-0.5 font-semibold text-primary-text hover:underline">
              <ExternalLink className="size-3" aria-hidden /> Map
            </a>
          ) : null}
        </p>
      </div>
    </div>
  );
}
