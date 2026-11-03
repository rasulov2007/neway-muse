import { useState } from 'react';
import { Plus } from 'lucide-react';
import { PM_SETTINGS, type PmPlan } from '@neway/shared';
import { Button, FormField, Input, Modal, Select, useToast } from '@/design-system';
import { usePmPlans, useSetPmPlan, useSetUnitGroup } from './api';

const n = (v: number) => v.toLocaleString('en-US');
/** Radix refuses an empty item value, so the fleet default rides under a name of its own. */
const FLEET = '__fleet';

/** The oil-change group plans: one per truck type, as the owner calls them. */
function truckTypes(plans: PmPlan[] | undefined): PmPlan[] {
  return (plans ?? []).filter(
    (p) => p.scope === 'group' && !p.voidedAt && p.serviceCode === 'OIL_CHANGE' && p.groupName,
  );
}

/**
 * Truck types and their oil-change interval (owner's ask, 2026-09-22): a Freightliner every
 * 25,000 mi, a Volvo every 30,000. A type is a PM group plan - the engine already reads a unit's
 * group before the fleet default (§3.2) - so nothing new is computed here; the dialog names the
 * groups and puts a unit in one. With a unit, the picker sets that unit's type; without one, it
 * only manages the list.
 */
export function TruckTypeDialog({
  unit,
  onClose,
}: {
  unit?: { id: string; unitNumber: string; groupName: string | null };
  onClose: () => void;
}) {
  const { toast } = useToast();
  const plans = usePmPlans();
  const setPlan = useSetPmPlan();
  const setGroup = useSetUnitGroup();
  const types = truckTypes(plans.data);
  const [groupName, setGroupName] = useState<string>(unit?.groupName ?? '');
  const [adding, setAdding] = useState(false);
  // The form is open when asked for, or when there is nothing to pick from yet.
  const showForm = adding || (!plans.isPending && types.length === 0);
  const [newName, setNewName] = useState('');
  const [newMiles, setNewMiles] = useState('');
  const [error, setError] = useState<string | null>(null);

  const addType = async () => {
    const name = newName.trim();
    const miles = Number(newMiles);
    if (!name) return setError('Name the truck type - Freightliner, Volvo, Kenworth…');
    if (!Number.isFinite(miles) || miles < 5_000 || miles > 100_000)
      return setError('The interval is in miles, between 5,000 and 100,000.');
    setError(null);
    try {
      await setPlan.mutateAsync({ scope: 'group', groupName: name, intervalMiles: miles });
      toast({ tone: 'success', title: `${name} · every ${n(miles)} mi` });
      setGroupName(name);
      setNewName('');
      setNewMiles('');
      setAdding(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The truck type could not be saved.');
    }
  };

  const save = async () => {
    if (!unit) return onClose();
    try {
      await setGroup.mutateAsync({ unitId: unit.id, groupName: groupName || null });
      const picked = types.find((t) => t.groupName === groupName);
      toast({
        tone: 'success',
        title: picked
          ? `${unit.unitNumber} is a ${picked.groupName} · every ${n(picked.intervalMiles)} mi`
          : `${unit.unitNumber} uses the fleet interval · every ${n(PM_SETTINGS.fleetIntervalMiles)} mi`,
      });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The truck type could not be saved.');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      title={unit ? 'Truck type' : 'Truck types'}
      description={
        unit
          ? `Unit ${unit.unitNumber}. The type sets how many miles between oil changes.`
          : 'Each type carries its own miles between oil changes; a unit takes its type’s interval.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {unit ? 'Cancel' : 'Close'}
          </Button>
          {unit ? (
            <Button loading={setGroup.isPending} onClick={save}>
              Save truck type
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        {unit ? (
          <FormField
            label="Truck type"
            description={
              types.length === 0
                ? 'No truck types yet - add the first one below.'
                : 'Pick the type this unit is; its interval follows.'
            }
          >
            <Select
              aria-label="Truck type"
              value={groupName || FLEET}
              onValueChange={(v) => setGroupName(v === FLEET ? '' : v)}
              placeholder="Fleet default"
              options={[
                {
                  value: FLEET,
                  label: `Fleet default · every ${n(PM_SETTINGS.fleetIntervalMiles)} mi`,
                },
                ...types.map((t) => ({
                  value: t.groupName as string,
                  label: `${t.groupName} · every ${n(t.intervalMiles)} mi`,
                })),
              ]}
            />
          </FormField>
        ) : (
          <ul className="divide-y divide-nw-border rounded-lg border border-nw-border">
            {plans.isPending ? (
              <li className="px-3 py-2 text-sm text-muted">Loading…</li>
            ) : types.length === 0 ? (
              <li className="px-3 py-2 text-sm text-muted">No truck types yet.</li>
            ) : (
              types.map((t) => (
                <li key={t.id} className="flex items-center justify-between px-3 py-2 text-sm">
                  <span className="font-medium text-ink">{t.groupName}</span>
                  <span className="text-muted tabular-nums">every {n(t.intervalMiles)} mi</span>
                </li>
              ))
            )}
          </ul>
        )}

        {showForm ? (
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
              {types.length > 0 ? (
                <Button size="sm" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              ) : null}
              <Button size="sm" loading={setPlan.isPending} onClick={addType}>
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
        )}
      </div>
    </Modal>
  );
}
