import { useState } from 'react';
import {
  CONTACT_METHODS,
  CONTACT_METHOD_LABELS,
  type ContactMethod,
  type DriverRelationRequest,
} from '@neway/shared';
import { Button, Modal, Select, Textarea } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { useDriverMessage } from './api';

/**
 * Logs a message the driver sent some other way (a call, a text, Telegram). Like a new message
 * through Driver Care, it puts the red alert back until somebody contacts them again, and reopens
 * a resolved request.
 */
export function DriverMessageButton({ request, disabled }: { request: DriverRelationRequest; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [method, setMethod] = useState<ContactMethod>('phone');
  const [error, setError] = useState<string | null>(null);
  const write = useDriverMessage();

  const save = async () => {
    if (write.isPending) return;
    if (!message.trim()) {
      setError('Write what the driver said.');
      return;
    }
    setError(null);
    try {
      await write.mutateAsync({ id: request.id, body: { message: message.trim(), method, expectedVersion: request.version } });
      setMessage('');
      setOpen(false);
    } catch (e) {
      setError(e instanceof ApiError ? `Not saved: ${e.message}` : 'Not saved. Your text is still here; try again.');
    }
  };

  return (
    <>
      <Button variant="ghost" disabled={disabled} onClick={() => setOpen(true)}>
        Log driver message
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="New message from the driver"
        description="The request will need contact again."
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={() => void save()} loading={write.isPending} disabled={write.isPending}>
              Save message
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1.5 text-xs font-semibold text-nw-text-2">
            <span id="dm-method">How it came in</span>
            <Select
              aria-labelledby="dm-method"
              value={method}
              onValueChange={(v) => setMethod(v as ContactMethod)}
              options={CONTACT_METHODS.map((m) => ({ value: m, label: CONTACT_METHOD_LABELS[m] }))}
            />
          </label>
          <label htmlFor="dm-text" className="text-xs font-semibold text-nw-text-2">
            What the driver said (required)
          </label>
          <Textarea id="dm-text" rows={4} value={message} onChange={(e) => setMessage(e.target.value)} maxLength={4000} />
          {error ? (
            <p role="alert" className="text-xs text-nw-urgent-text">
              {error}
            </p>
          ) : null}
        </div>
      </Modal>
    </>
  );
}
