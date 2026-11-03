import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { setUnitDocumentRule, unitDocumentRules, type UnitDocumentRule } from '@/demo';
import { Badge, Card, Select, useToast } from '@/design-system';
import { defaultDocumentRule, documentTypesFor } from '../unit-documents';

/** Admin → Settings: what an expired document of each type does to the unit. */
export function UnitDocumentRulesCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const rules = useQuery({ queryKey: ['fleet', 'document-rules'], queryFn: () => unitDocumentRules() });
  const save = useMutation({
    mutationFn: ({ code, rule }: { code: string; rule: UnitDocumentRule }) => setUnitDocumentRule(code, rule),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fleet'] }),
    onError: (e: unknown) =>
      toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  const overrides = rules.data ?? {};

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-md font-bold text-ink">Unit document types</h2>
        <p className="text-xs text-muted">
          The paperwork a truck or trailer carries, and what an expired one does: a type that blocks
          dispatch takes the unit off the board until a current document is on file; a type that
          warns only raises it on the fleet action queue.
        </p>
      </div>
      {(['truck', 'trailer'] as const).map((scope) => (
        <div key={scope} className="flex flex-col gap-2">
          <h3 className="eyebrow">{scope === 'truck' ? 'Trucks' : 'Trailers'}</h3>
          <ul className="divide-y divide-line-soft rounded-lg border border-line">
            {documentTypesFor(scope).map((type) => {
              const rule = overrides[type.code] ?? defaultDocumentRule(type);
              return (
                <li key={type.code} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0 flex-1">
                    <span className="font-medium text-ink">{type.name}</span>
                    {type.hasExpiry ? null : (
                      <Badge tone="neutral" variant="outline" size="sm" className="ml-2">
                        No expiry
                      </Badge>
                    )}
                    <span className="block text-xs text-muted">{type.description}</span>
                  </span>
                  {type.hasExpiry ? (
                    <Select
                      aria-label={`${type.name} expiry rule`}
                      size="sm"
                      className="w-44"
                      options={[
                        { value: 'block', label: 'Blocks dispatch' },
                        { value: 'warn', label: 'Warns only' },
                      ]}
                      value={rule}
                      disabled={!canEdit || save.isPending}
                      onValueChange={(value) => save.mutate({ code: type.code, rule: value as UnitDocumentRule })}
                    />
                  ) : null}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </Card>
  );
}
