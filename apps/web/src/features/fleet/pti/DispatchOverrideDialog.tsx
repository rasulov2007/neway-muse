import { useState } from 'react';
import { describeDescriptionProblem } from '@neway/shared';
import { Alert, Button, FormField, Modal, Textarea } from '@/design-system';
import type { DispatchBlockedError } from '@/demo/dispatch-guard';

/**
 * The hold, at the moment somebody tries to dispatch through it (§9.1).
 *
 * The block is the rule; this is the exception, and it costs a sentence. The reason is checked
 * the way a defect description is - no "1111", no "ok" - because it is written on the defect's
 * history under the dispatcher's name and will be read back after the fact. Nothing here changes
 * the defect: the hold stands, and the next load on this unit is stopped again.
 */
export function DispatchOverrideDialog({
  blocked,
  onCancel,
  onOverride,
}: {
  blocked: DispatchBlockedError | null;
  onCancel: () => void;
  /** Re-runs the write with the reason. Resolves when it has saved; rejects with the write's error. */
  onOverride: (reason: string) => Promise<unknown>;
}) {
  const [reason, setReason] = useState('');
  const [touched, setTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const problem = describeDescriptionProblem(reason);

  const close = () => {
    setReason('');
    setTouched(false);
    setError(null);
    onCancel();
  };

  return (
    <Modal
      open={blocked !== null}
      onOpenChange={(open) => {
        if (!open && !saving) close();
      }}
      size="sm"
      title={blocked ? `Unit ${blocked.unitNumber} is out of service` : 'Out of service'}
      description="An open out-of-service defect holds this unit. Dispatching it anyway is allowed, and it is recorded on the defect under your name."
      dismissible={!saving}
      footer={
        <>
          <Button variant="secondary" onClick={close} disabled={saving}>
            Keep it off the road
          </Button>
          <Button
            variant="danger"
            loading={saving}
            disabled={problem !== null}
            onClick={() => {
              setTouched(true);
              if (problem) return;
              setSaving(true);
              setError(null);
              onOverride(reason.trim())
                .then(() => close())
                .catch((err: unknown) => setError(err instanceof Error ? err.message : 'The load could not be saved.'))
                .finally(() => setSaving(false));
            }}
          >
            Dispatch anyway
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {blocked ? (
          <Alert
            tone="danger"
            title={blocked.verdict.reason ? `Out of service — ${blocked.verdict.reason}` : 'Out of service'}
            description={blocked.verdict.releaseCondition ?? undefined}
          />
        ) : null}
        <FormField
          label="Why this unit is going out"
          description="Who checked it, what was done, and why it is safe for this load."
          required
          error={touched && problem ? problem : undefined}
        >
          <Textarea
            rows={3}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="e.g. Brakes checked by hand at the yard by Tom; 40 miles to the shop on the way to the shipper"
            autoFocus
          />
        </FormField>
        {error ? <Alert tone="danger" title="Not saved" description={error} /> : null}
      </div>
    </Modal>
  );
}
