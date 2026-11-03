import { useState } from 'react';
import { ConfirmDialog } from '@/design-system';

/**
 * "Leave without saving?" whenever an unfinished sheet is closed (owner's ask, 2026-09-21).
 * The X, Cancel and a click outside all come through `requestClose`. The owner asked for the
 * question every time, typed in or not: the sheet is a record in progress until it is saved.
 * `always` is the default; pass false to ask only once something was entered.
 */
export function useLeaveGuard(dirty: boolean, onClose: () => void, always = true) {
  const [asking, setAsking] = useState(false);
  const requestClose = () => (always || dirty ? setAsking(true) : onClose());
  const dialog = (
    <ConfirmDialog
      open={asking}
      onOpenChange={setAsking}
      title="Leave without saving?"
      description="What you entered here is not saved and will be gone."
      confirmLabel="Leave"
      cancelLabel="Stay"
      tone="danger"
      onConfirm={() => {
        setAsking(false);
        onClose();
      }}
    />
  );
  return { requestClose, dialog };
}
