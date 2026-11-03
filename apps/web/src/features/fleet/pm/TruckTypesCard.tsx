import { useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { PM_SETTINGS, type PmPlan } from '@neway/shared';
import { Button, Card, FormField, Input, Select, useToast } from '@/design-system';
import { usePmBoard, usePmPlans, useSetPmPlan, useSetUnitGroup } from './api';

const n = (v: number) => v.toLocaleString('en-US');
/** Radix refuses an empty item value, so the fleet default rides under a name of its own. */
const FLEET = '__fleet';

function truckTypes(plans: PmPlan[] | undefined): PmPlan[] {
  return (plans ?? []).filter(
    (p) => p.scope === 'group' && !p.voidedAt && p.serviceCode === 'OIL_CHANGE' && p.groupName,
  );
}

/**
 * Settings › Truck types and oil-change intervals (owner's ask, 2026-09-22: "on the Settings
 * page"). A type is a PM group plan - Freightliner every 25,000 mi, Volvo every 30,000 - and a
 * unit takes its type's interval unless a plan of its own says otherwise. The same records the
 * Oil change page and the unit page edit; this card is where the whole fleet is set at once.
 */
export function TruckTypesCard({ canEdit }: { canEdit: boolean }) {
  const { toast } = useToast();
  const plans = usePmPlans();
  const board = usePmBoard();
  const setPlan = useSetPmPlan();
  const setGroup = useSetUnitGroup();
  const types = truckTypes(plans.data);

  const [adding, setAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newMiles, setNewMiles] = useState('');
  const [editing, setEditing] = useState<{ name: string; miles: string } | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = [...(board.data?.rows ?? [])].sort((a, b) =>
      a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true }),
    );
    const needle = q.trim().toLowerCase();
    return needle
      ? all.filter((r) =>
          `${r.unitNumber} ${r.driverName ?? ''} ${r.groupName ?? ''}`
            .toLowerCase()
            .includes(needle),
        )
      : all;
  }, [board.data, q]);
  const unitCount = (name: string) =>
    (board.data?.rows ?? []).filter((r) => r.groupName === name).length;

  const savePlan = async (name: string, milesText: string) => {
    const miles = Number(milesText);
    if (!name.trim()) return setError('Name the truck type - Freightliner, Volvo, Kenworth…');
    if (!Number.isFinite(miles) || miles < 5_000 || miles > 100_000)
      return setError('The interval is in miles, between 5,000 and 100,000.');
    setError(null);
    try {
      await setPlan.mutateAsync({ scope: 'group', groupName: name.trim(), intervalMiles: miles });
      toast({ tone: 'success', title: `${name.trim()} · every ${n(miles)} mi` });
      setAdding(false);
      setEditing(null);
      setNewName('');
      setNewMiles('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The truck type could not be saved.');
    }
  };

  const assign = async (unitId: string, unitNumber: string, groupName: string | null) => {
    try {
      await setGroup.mutateAsync({ unitId, groupName });
      const picked = types.find((t) => t.groupName === groupName);
      toast({
        tone: 'success',
        title: picked
          ? `${unitNumber} is a ${picked.groupName} · every ${n(picked.intervalMiles)} mi`
          : `${unitNumber} uses the fleet interval`,
      });
    } catch (e) {
      toast({
        tone: 'danger',
        title: 'Not saved',
        description: e instanceof Error ? e.message : undefined,
      });
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <div>
        <h2 className="text-md font-bold text-ink">Truck types and oil-change intervals</h2>
        <p className="text-xs text-muted">
          Each type carries its own miles between oil changes; a unit follows its type. Without a
          type a unit uses the fleet interval of every {n(PM_SETTINGS.fleetIntervalMiles)} mi.
        </p>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger-text">
          {error}
        </p>
      ) : null}

      {/* The types */}
      <div className="overflow-hidden rounded-lg border border-nw-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-nw-border bg-nw-subtle text-left text-[11px] font-bold tracking-[.06em] text-nw-text-2 uppercase">
              <th className="px-3 py-2">Truck type</th>
              <th className="px-3 py-2 text-right">Oil change every</th>
              <th className="px-3 py-2 text-right">Units</th>
              <th className="w-24 px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {plans.isPending ? (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-nw-text-3">
                  Loading…
                </td>
              </tr>
            ) : types.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-4 text-center text-nw-text-3">
                  No truck types yet.
                </td>
              </tr>
            ) : (
              types.map((t) =>
                editing?.name === t.groupName ? (
                  <tr key={t.id} className="border-b border-nw-border last:border-b-0">
                    <td className="px-3 py-2 font-medium text-ink">{t.groupName}</td>
                    <td className="px-3 py-2 text-right">
                      <Input
                        size="sm"
                        type="number"
                        inputMode="numeric"
                        aria-label={`Interval for ${t.groupName}`}
                        value={editing.miles}
                        onChange={(e) => setEditing({ name: editing.name, miles: e.target.value })}
                        className="ml-auto w-28 text-right"
                      />
                    </td>
                    <td className="tabular px-3 py-2 text-right text-nw-text-2">
                      {unitCount(t.groupName as string)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <span className="flex justify-end gap-1">
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          Cancel
                        </Button>
                        <Button
                          size="sm"
                          loading={setPlan.isPending}
                          onClick={() => savePlan(editing.name, editing.miles)}
                        >
                          Save
                        </Button>
                      </span>
                    </td>
                  </tr>
                ) : (
                  <tr key={t.id} className="border-b border-nw-border last:border-b-0">
                    <td className="px-3 py-2 font-medium text-ink">{t.groupName}</td>
                    <td className="tabular px-3 py-2 text-right text-ink">
                      {n(t.intervalMiles)} mi
                    </td>
                    <td className="tabular px-3 py-2 text-right text-nw-text-2">
                      {board.data ? unitCount(t.groupName as string) : '…'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      {canEdit ? (
                        <Button
                          size="sm"
                          variant="link"
                          onClick={() =>
                            setEditing({
                              name: t.groupName as string,
                              miles: String(t.intervalMiles),
                            })
                          }
                        >
                          Change
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                ),
              )
            )}
          </tbody>
        </table>
      </div>

      {canEdit ? (
        adding ? (
          <div className="flex flex-col gap-3 rounded-lg border border-nw-border bg-nw-subtle p-3">
            <span className="text-sm font-semibold text-ink">Add truck type</span>
            <div className="grid gap-3 sm:grid-cols-2">
              <FormField label="Type" required>
                <Input
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="Freightliner"
                  autoFocus
                />
              </FormField>
              <FormField label="Oil change every (mi)" required>
                <Input
                  type="number"
                  inputMode="numeric"
                  value={newMiles}
                  onChange={(e) => setNewMiles(e.target.value)}
                  placeholder="25000"
                />
              </FormField>
            </div>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button
                size="sm"
                loading={setPlan.isPending}
                onClick={() => savePlan(newName, newMiles)}
              >
                Add type
              </Button>
            </div>
          </div>
        ) : (
          <div>
            <Button variant="outline" size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
              Add truck type
            </Button>
          </div>
        )
      ) : null}

      {/* The units, each with its type */}
      <div className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm font-semibold text-ink">Which type each unit is</span>
          <label className="flex h-8 w-64 items-center gap-2 rounded-lg border border-nw-border-strong bg-nw-field px-2.5 text-xs text-nw-text-3 focus-within:border-nw-accent">
            <Search className="size-3.5 shrink-0" aria-hidden />
            <input
              type="search"
              aria-label="Search units"
              placeholder="Unit, driver or type…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="w-full min-w-0 bg-transparent text-nw-text outline-none placeholder:text-nw-text-3"
            />
          </label>
        </div>
        <div className="max-h-96 overflow-auto rounded-lg border border-nw-border">
          <table className="w-full text-sm">
            <thead className="sticky top-0">
              <tr className="border-b border-nw-border bg-nw-subtle text-left text-[11px] font-bold tracking-[.06em] text-nw-text-2 uppercase">
                <th className="px-3 py-2">Unit</th>
                <th className="px-3 py-2">Driver</th>
                <th className="px-3 py-2 text-right">Interval used</th>
                <th className="w-64 px-3 py-2">Truck type</th>
              </tr>
            </thead>
            <tbody>
              {board.isPending ? (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-nw-text-3">
                    Loading…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-3 py-4 text-center text-nw-text-3">
                    No units match.
                  </td>
                </tr>
              ) : (
                rows.map((r) => (
                  <tr key={r.unitId} className="border-b border-nw-border last:border-b-0">
                    <td className="px-3 py-1.5 font-medium text-ink">{r.unitNumber}</td>
                    <td className="px-3 py-1.5 text-nw-text-2">{r.driverName ?? '—'}</td>
                    <td className="tabular px-3 py-1.5 text-right text-nw-text-2">
                      {r.intervalMiles === null ? '—' : `${n(r.intervalMiles)} mi`}
                      {r.planOrigin === 'unit' ? (
                        <span className="ml-1 text-[11px] text-nw-text-3">(own plan)</span>
                      ) : null}
                    </td>
                    <td className="px-3 py-1.5">
                      <Select
                        size="sm"
                        aria-label={`Truck type of ${r.unitNumber}`}
                        value={r.groupName ?? FLEET}
                        disabled={!canEdit || setGroup.isPending}
                        onValueChange={(v) =>
                          assign(r.unitId, r.unitNumber, v === FLEET ? null : v)
                        }
                        options={[
                          { value: FLEET, label: 'Fleet default' },
                          ...types.map((t) => ({
                            value: t.groupName as string,
                            label: `${t.groupName} · ${n(t.intervalMiles)} mi`,
                          })),
                          // A unit already in a group with no plan row keeps its name on the list.
                          ...(r.groupName && !types.some((t) => t.groupName === r.groupName)
                            ? [{ value: r.groupName, label: r.groupName }]
                            : []),
                        ]}
                      />
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}
