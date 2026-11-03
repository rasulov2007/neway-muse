import { useState } from 'react';
import { Modal, Select, StatusBadge } from '@/design-system';
import { UploadDocumentDialog } from '../UploadDocumentDialog';
import { useCompliance } from '../useCompliance';

/**
 * Upload from the driver row (owner, 2026-10-16): pick which requirement the file answers, then the
 * same attach dialog the qualification file uses, so the document lands on that requirement and
 * waits there for Verify.
 */
export function DriverUploadModal({ driverId, driverName, onClose }: { driverId: string; driverName: string; onClose: () => void }) {
  const bundle = useCompliance();
  const entity = bundle.data?.byKey.get(`driver:${driverId}`) ?? null;
  // What still needs a document first, then everything else (a renewal can be filed early).
  const items = entity ? [...entity.items].sort((a, b) => Number(b.requiredAction !== null) - Number(a.requiredAction !== null)) : [];
  const [code, setCode] = useState('');
  const item = items.find((i) => i.requirementCode === code) ?? null;

  if (item) {
    return <UploadDocumentDialog item={item} ownerType="driver" open onOpenChange={(open) => !open && onClose()} />;
  }
  return (
    <Modal open onOpenChange={(open) => !open && onClose()} title={`Upload a document · ${driverName}`} description="Choose the requirement this file answers.">
      {bundle.isLoading ? (
        <p className="text-sm text-nw-text-3">Loading…</p>
      ) : !entity ? (
        <p className="text-sm text-nw-text-3">This driver has no qualification file yet.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <Select
            aria-label="Requirement"
            placeholder="Pick a requirement…"
            value={code}
            onValueChange={setCode}
            options={items.map((i) => ({ value: i.requirementCode, label: i.requirementName }))}
          />
          <ul className="flex flex-col gap-1 text-xs text-nw-text-2">
            {items
              .filter((i) => i.requiredAction !== null)
              .slice(0, 6)
              .map((i) => (
                <li key={i.requirementCode} className="flex items-center gap-2">
                  <StatusBadge status={i.status} size="sm" />
                  <button type="button" className="text-left hover:underline" onClick={() => setCode(i.requirementCode)}>
                    {i.requirementName}
                  </button>
                </li>
              ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}
