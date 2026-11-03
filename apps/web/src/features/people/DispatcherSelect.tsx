import { useState } from 'react';
import { Combobox } from '@/design-system';
import { CreateDispatcherDialog } from './CreateEmployeeDialog';
import { dispatcherOptions, useDispatchers } from './useDispatchers';
import { useHasPermission } from '@/features/admin/useAdmin';

/** A recorded dispatcher who is not on the list (an older id, or inactive) still shows by name. */
function withCurrent(
  options: { value: string; label: string; description?: string }[],
  value: string | null,
  label: string | null | undefined,
) {
  if (!value || !label || options.some((o) => o.value === value)) return options;
  return [{ value, label, description: 'On the record' }, ...options];
}

/**
 * The dispatcher picker every form uses (2026-09-21): the shared list, with "+ Create
 * dispatcher" at the bottom for a name that is not on it. Creating opens the overlay over the
 * form; on success the picker selects the new dispatcher and the rest of the form is untouched -
 * the assignment is saved when the form is submitted, not before.
 */
export function DispatcherSelect({
  id,
  value,
  onValueChange,
  onBlur,
  placeholder = 'Select a dispatcher',
  disabled,
  allowCreate = true,
  currentLabel,
  label = 'Dispatcher',
}: {
  id?: string;
  value: string | null;
  onValueChange: (id: string | null) => void;
  onBlur?: () => void;
  placeholder?: string;
  disabled?: boolean;
  allowCreate?: boolean;
  /** The name recorded with the current value, shown while that person is not on the list. */
  currentLabel?: string | null;
  /** The accessible name; the same picker also chooses a load's updater. */
  label?: string;
}) {
  const dispatchers = useDispatchers();
  // Adding an employee - a dispatcher included - is HR's (owner, 2026-10-25): the server refuses
  // POST /employees without employees.create, so the picker does not offer it either.
  const mayCreate = useHasPermission('employees.create');
  const [creating, setCreating] = useState<string | null>(null);
  return (
    <>
      <Combobox
        id={id}
        aria-label={label}
        options={withCurrent(dispatcherOptions(dispatchers.data, value), value, currentLabel)}
        value={value || null}
        onValueChange={onValueChange}
        onBlur={onBlur}
        disabled={disabled}
        loading={dispatchers.isPending}
        placeholder={dispatchers.isPending ? 'Loading…' : placeholder}
        searchPlaceholder="Type a dispatcher name…"
        emptyMessage="No dispatcher matches"
        onCreate={allowCreate && mayCreate ? (typed) => setCreating(typed) : undefined}
        createLabel={(typed) => (typed ? `+ Create dispatcher "${typed}"` : '+ Create dispatcher')}
      />
      <CreateDispatcherDialog
        open={creating !== null}
        initialName={creating ?? ''}
        onOpenChange={(open) => {
          if (!open) setCreating(null);
        }}
        onCreated={(created) => onValueChange(created.id)}
      />
    </>
  );
}
