import { useState } from 'react';
import {
  ASSIGNMENT_ITEMS,
  ASSIGNMENT_ITEM_LABEL,
  type AssignmentEquipment,
  type AssignmentItem,
} from '@neway/shared';
import { Button, Checkbox, Input } from '@/design-system';

/** One line of the checklist while it is being edited. */
export interface ItemDraft {
  item: AssignmentItem;
  label: string;
  detail: string;
  /** Pickup: handed over. Drop: returned. */
  checked: boolean;
}

export const DEFAULT_ITEMS: ItemDraft[] = ASSIGNMENT_ITEMS.filter((i) => i !== 'other').map(
  (item) => ({ item, label: ASSIGNMENT_ITEM_LABEL[item], detail: '', checked: false }),
);

/** The full pickup list (fixed items + "other" lines) with what the record says. */
export function draftsFromEquipment(items: AssignmentEquipment[]): ItemDraft[] {
  const drafts = DEFAULT_ITEMS.map((d) => {
    const found = items.find((e) => e.item === d.item);
    return found ? { ...d, detail: found.detail ?? '', checked: found.handedOver } : d;
  });
  for (const e of items.filter((x) => x.item === 'other')) {
    drafts.push({ item: 'other', label: e.label, detail: e.detail ?? '', checked: e.handedOver });
  }
  return drafts;
}

/**
 * The returned list for a drop, pre-filled from what was handed over: each handed-over item is a
 * line, ticked as returned, with its serial. An existing returned list wins where there is one.
 */
export function returnDraftsFrom(
  handed: AssignmentEquipment[],
  returned: AssignmentEquipment[] | null,
): ItemDraft[] {
  if (returned) {
    return returned.map((e) => ({
      item: e.item,
      label: e.label,
      detail: e.detail ?? '',
      checked: e.handedOver,
    }));
  }
  return handed
    .filter((e) => e.handedOver)
    .map((e) => ({ item: e.item, label: e.label, detail: e.detail ?? '', checked: true }));
}

/**
 * Drafts → the record's shape. Pickup keeps ticked lines and lines with a detail typed (a serial
 * of something not handed over is still worth keeping); a drop keeps every line, ticked or not,
 * because "not returned" is the answer that matters.
 */
export function draftsToEquipment(drafts: ItemDraft[], mode: 'pickup' | 'drop'): AssignmentEquipment[] {
  return drafts
    .filter((d) => mode === 'drop' || d.checked || d.detail.trim())
    .map((d) => ({
      item: d.item,
      label: d.label,
      detail: d.detail.trim() || null,
      handedOver: d.checked,
    }));
}

export function EquipmentChecklist({
  items,
  onChange,
  mode,
}: {
  items: ItemDraft[];
  onChange: (next: ItemDraft[]) => void;
  mode: 'pickup' | 'drop';
}) {
  const [other, setOther] = useState('');
  const patch = (index: number, next: Partial<ItemDraft>) =>
    onChange(items.map((it, i) => (i === index ? { ...it, ...next } : it)));
  const verb = mode === 'drop' ? 'returned' : 'handed over';
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line-soft p-3">
      {items.length === 0 ? (
        <p className="text-sm text-muted">Nothing was recorded as handed over.</p>
      ) : null}
      {items.map((it, index) => (
        <div
          key={`${it.item}-${index}`}
          className="grid items-center gap-2 sm:grid-cols-[150px_minmax(0,1fr)]"
        >
          <Checkbox
            checked={it.checked}
            onCheckedChange={(checked) => patch(index, { checked: checked === true })}
            label={it.label}
            aria-label={`${it.label} ${verb}`}
          />
          <Input
            size="sm"
            aria-label={`${it.label} detail`}
            value={it.detail}
            onChange={(e) => patch(index, { detail: e.target.value })}
            placeholder="Serial, model or tag number (optional)"
          />
        </div>
      ))}
      <div className="flex items-center gap-2 border-t border-line-soft pt-2">
        <Input
          size="sm"
          aria-label={mode === 'drop' ? 'Something else returned' : 'Other item'}
          value={other}
          onChange={(e) => setOther(e.target.value)}
          placeholder={mode === 'drop' ? 'Something else returned…' : 'Something else handed over…'}
        />
        <Button
          size="sm"
          variant="secondary"
          disabled={!other.trim()}
          onClick={() => {
            onChange([...items, { item: 'other', label: other.trim().slice(0, 60), detail: '', checked: true }]);
            setOther('');
          }}
        >
          Add
        </Button>
      </div>
    </div>
  );
}
