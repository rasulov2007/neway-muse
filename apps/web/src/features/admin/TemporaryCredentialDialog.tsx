import { useState } from 'react';
import { Check, Copy, TriangleAlert } from 'lucide-react';
import { Button, Modal } from '@/design-system';

/**
 * The one time a password is ever shown.
 *
 * The database keeps a scrypt hash, so once this dialog closes nothing in the system can say what
 * the password was — which is exactly why the warning is not decoration. There is no "show again":
 * an administrator who loses it issues a new one.
 */
export function TemporaryCredentialDialog({
  email,
  temporaryPassword,
  onClose,
}: {
  email: string;
  temporaryPassword: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(temporaryPassword);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard permission refused; the password is on screen to be read.
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title="Temporary password"
      description={`For ${email}`}
      footer={
        <Button variant="primary" onClick={onClose}>
          Done
        </Button>
      }
    >
      <div className="flex flex-col gap-3">
        <div
          className="flex items-center justify-between gap-3 rounded-md border px-3 py-2.5"
          style={{
            borderColor: 'var(--color-line-strong)',
            backgroundColor: 'var(--color-surface-muted)',
          }}
        >
          <code className="tabular text-md font-semibold tracking-wide text-ink select-all">
            {temporaryPassword}
          </code>
          <Button
            variant="secondary"
            size="sm"
            icon={copied ? <Check /> : <Copy />}
            onClick={() => void copy()}
          >
            {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>

        <p
          className="flex items-start gap-2 rounded-md border px-3 py-2 text-sm"
          style={{
            borderColor: 'var(--color-warning-border)',
            backgroundColor: 'var(--color-warning-soft)',
            color: 'var(--color-warning-text)',
          }}
        >
          <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
          <span>
            This password will only be shown now. Store it securely and provide it to the user.
          </span>
        </p>

        <p className="text-sm text-secondary">
          They will be asked to choose their own password the first time they sign in, and nothing
          else in NeWay opens until they do.
        </p>
      </div>
    </Modal>
  );
}
