import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ensureWorkOrderTypes,
  saveWorkOrderType,
  type WorkOrderTypeDef,
  type WorkOrderUnitKind,
} from '@/demo';
import { Card, Select, Switch, useToast } from '@/design-system';

const APPLIES: Array<{ value: WorkOrderUnitKind | 'both'; label: string }> = [
  { value: 'truck', label: 'Trucks' },
  { value: 'trailer', label: 'Trailers' },
  { value: 'both', label: 'Trucks and trailers' },
];

/** Admin → Settings: which kinds of work the work-order dialog offers, and for which units. */
export function WorkOrderTypeCatalogCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const catalog = useQuery({
    queryKey: ['fleet', 'work-order-types'],
    queryFn: () => [...ensureWorkOrderTypes()].sort((a, b) => a.sortOrder - b.sortOrder),
  });
  const save = useMutation({
    mutationFn: (input: Parameters<typeof saveWorkOrderType>[0]) => saveWorkOrderType(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fleet', 'work-order-types'] }),
    onError: (err: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not saved',
        description: err instanceof Error ? err.message : undefined,
      }),
  });

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-md font-bold text-ink">Work order types</h2>
        <p className="text-xs text-muted">
          What a work order can be about, and whether it is offered for trucks, trailers or both.
          Existing orders keep their type when one is retired.
        </p>
      </div>
      <ul className="divide-y divide-line-soft rounded-lg border border-line">
        {(catalog.data ?? []).map((t: WorkOrderTypeDef) => (
          <li key={t.code} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
            <span className="min-w-0 flex-1">
              <span className="font-medium text-ink">{t.label}</span>
              <span className="ml-2 font-mono text-xs text-muted">{t.code}</span>
            </span>
            <Select
              aria-label={`${t.label} applies to`}
              size="sm"
              className="w-44"
              options={APPLIES}
              value={t.appliesTo}
              disabled={!canEdit || save.isPending}
              onValueChange={(value) =>
                save.mutate({ code: t.code, appliesTo: value as WorkOrderUnitKind | 'both' })
              }
            />
            <label className="flex items-center gap-2 text-xs text-secondary">
              Active
              <Switch
                aria-label={`${t.label} active`}
                checked={t.active}
                disabled={!canEdit || save.isPending}
                onCheckedChange={(active) => save.mutate({ code: t.code, active })}
              />
            </label>
          </li>
        ))}
      </ul>
    </Card>
  );
}
