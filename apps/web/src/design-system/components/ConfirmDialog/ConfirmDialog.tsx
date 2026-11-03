import { useState, type ReactNode } from 'react';
import { Button } from '../Button';
import { Modal } from '../Modal';

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  /** Spell out the consequence ("This removes the truck from all future loads."). */
  description?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` renders a red confirm button; use only for destructive actions. */
  tone?: 'default' | 'danger';
  /**
   * May return a promise: the confirm button shows a spinner and the dialog stays open until it
   * settles. On success the dialog closes; on rejection it stays open (report the error yourself).
   */
  onConfirm: () => void | Promise<unknown>;
  /**
   * Hides the confirm button, leaving only dismiss. For a dialog that explains why an action
   * cannot proceed: there is nothing to confirm until the blockers are cleared, and a disabled
   * confirm button reads as a bug rather than an explanation.
   */
  hideConfirm?: boolean;
  children?: ReactNode;
}

/** Small modal for confirmations, async-aware. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'default',
  onConfirm,
  hideConfirm = false,
  children,
}: ConfirmDialogProps) {
  const [loading, setLoading] = useState(false);

  async function handleConfirm() {
    setLoading(true);
    try {
      await onConfirm();
      onOpenChange(false);
    } catch {
      // Stay open; the caller surfaces the failure (toast, inline error).
    } finally {
      setLoading(false);
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!loading) onOpenChange(next);
      }}
      size="sm"
      title={title}
      description={description}
      dismissible={!loading}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)} disabled={loading}>
            {hideConfirm ? 'Close' : cancelLabel}
          </Button>
          {hideConfirm ? null : (
            <Button
              variant={tone === 'danger' ? 'danger' : 'primary'}
              onClick={handleConfirm}
              loading={loading}
            >
              {confirmLabel}
            </Button>
          )}
        </>
      }
    >
      {children}
    </Modal>
  );
}
