import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';
import { HOME_ZONE, formatInstant } from '@neway/shared';
import { clearLoadRoute, loadWriteMessage, type Load } from '@/demo';
import { Button, Card, useToast } from '@/design-system';
import { formatMoney } from '@/lib/format';
import { RouteOptionsPanel, durationText } from './RouteOptionsPanel';

/**
 * The road chosen for the load from TollGuru's options (owner, 2026-10-27), on the load page:
 * the road, miles, time, tolls and fuel as priced, who chose it, the map link, and Change to
 * open the options again.
 */
export function LoadRouteCard({ load }: { load: Load }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const route = load.route ?? null;
  const clear = useMutation({
    mutationFn: () => clearLoadRoute(load.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['load'] }),
    onError: (err) => toast({ tone: 'danger', title: 'Route not cleared', description: loadWriteMessage(err, 'Try again.') }),
  });

  if (open) {
    return (
      <RouteOptionsPanel
        load={load}
        onChosen={() => {
          setOpen(false);
          toast({ tone: 'success', title: 'Route saved', description: 'The driver message now carries the Route line.' });
        }}
        onSkip={() => setOpen(false)}
        skipLabel="Cancel"
      />
    );
  }

  return (
    <Card
      title="Road & tolls"
      data-testid="load-route-card"
      actions={
        <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
          {route ? 'Change' : 'Route options'}
        </Button>
      }
    >
      {route ? (
        <div className="flex flex-col gap-2 text-sm">
          <p className="font-semibold text-ink">
            {route.via}
            {route.label !== route.via ? <span className="font-normal text-muted"> · {route.label} when chosen</span> : null}
          </p>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
            <Fact label="Miles" value={`${route.miles.toLocaleString('en-US')} mi`} />
            <Fact label="Time" value={durationText(route.durationMinutes)} />
            <Fact label="Tolls" value={route.tollCost > 0 ? formatMoney(route.tollCost) : 'No tolls'} />
            <Fact label="Fuel" value={formatMoney(route.fuelCost)} />
            <Fact label="Total" value={formatMoney(route.totalCost)} />
            <Fact label="Fuel priced at" value={`${formatMoney(route.settings.fuelPricePerGallon)}/gal · ${route.settings.mpg} mpg`} />
          </dl>
          <p className="text-xs text-muted">
            Chosen by {route.chosenByName} · {formatInstant(route.chosenAt, HOME_ZONE).text}
          </p>
          <div className="flex flex-wrap gap-2">
            {route.mapUrl ? (
              <a href={route.mapUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs font-semibold text-primary-text hover:underline">
                <ExternalLink className="size-3.5" aria-hidden /> Open in TollGuru map
              </a>
            ) : null}
            <Button size="sm" variant="ghost" onClick={() => clear.mutate()} loading={clear.isPending}>
              Clear route
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-sm text-muted">No route chosen. Route options show the roads TollGuru prices for this load, with tolls and fuel.</p>
      )}
    </Card>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-muted">{label}</dt>
      <dd className="tabular-nums text-ink">{value}</dd>
    </div>
  );
}
