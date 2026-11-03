import { useState } from 'react';
import { Button, FormField, Input, Modal, useToast } from '@/design-system';
import { useSetPmPlan } from './api';
import { oilIntervalMiles } from './oil-interval';

const n = (v: number) => v.toLocaleString('en-US');

/**
 * Miles between oil changes for one truck (owner, 2026-10-10): no truck types, just the number.
 * It starts at 25,000; typing 30 means 30,000. Saved as the unit's own plan, which the PM engine
 * already reads before any group or fleet default, and which supersedes the previous one.
 */
export function OilIntervalDialog({
  unit,
  currentMiles,
  onClose,
}: {
  unit: { id: string; unitNumber: string };
  currentMiles: number | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const setPlan = useSetPmPlan();
  const [value, setValue] = useState(String(currentMiles ?? 25_000));
  const [error, setError] = useState<string | null>(null);
  const miles = oilIntervalMiles(value);

  const save = async () => {
    if (miles === null) return setError('Miles between oil changes, from 5,000 to 100,000 (30 = 30,000).');
    setError(null);
    try {
      await setPlan.mutateAsync({
        scope: 'unit',
        unitId: unit.id,
        intervalMiles: miles,
        reason: 'Set on the unit page',
      });
      toast({ tone: 'success', title: `${unit.unitNumber} · oil change every ${n(miles)} mi` });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The interval could not be saved.');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title="Oil change interval"
      description={`Unit ${unit.unitNumber}. How many miles between oil changes.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={setPlan.isPending} onClick={save}>
            Save
          </Button>
        </>
      }
    >
      <FormField
        label="Oil change every (mi)"
        required
        description={miles !== null ? `Every ${n(miles)} miles` : '25 = 25,000 · 30 = 30,000'}
      >
        <Input
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
          autoFocus
          placeholder="25000"
        />
      </FormField>
      {error ? (
        <p role="alert" className="mt-2 text-sm text-danger-text">
          {error}
        </p>
      ) : null}
    </Modal>
  );
}
