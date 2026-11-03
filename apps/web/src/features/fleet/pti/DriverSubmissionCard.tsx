import { Smartphone, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { DRIVER_PTI_RESULT_LABEL, type PtiInspection } from '@neway/shared';
import { Alert, Badge, Button, Textarea, useToast } from '@/design-system';
import { formatDateTime } from '@/lib/format';
import { useRequestPtiCorrection } from './api';

/**
 * The walk-around the driver sent from the NeWay driver app (mobile, 2026-10-27): who, when, what
 * the checklist said, and Request correction - which sends it back to the driver with a reason.
 * Mark reviewed is the drawer's ordinary save; a defect goes to Fleet the ordinary way too.
 */
export function DriverSubmissionCard({ inspection, canWrite }: { inspection: PtiInspection; canWrite: boolean }) {
  const { toast } = useToast();
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const request = useRequestPtiCorrection();
  const submission = inspection.driverSubmission;
  const correction = inspection.correction ?? null;
  const history = inspection.driverHistory ?? [];

  if (!submission && !correction) return null;
  const flagged = submission?.checklist.filter((i) => i.result !== 'good') ?? [];
  const canAsk = canWrite && !!submission && !correction && inspection.reviewState !== 'reviewed';

  return (
    <section className="flex flex-col gap-2 rounded-lg border border-nw-border bg-nw-subtle p-3" aria-label="Sent from the driver app">
      {correction ? (
        <Alert
          tone="warning"
          title="Correction requested"
          description={`${correction.requestedBy} · ${formatDateTime(correction.requestedAt)} · ${correction.reason}. Waiting for the driver to send it again.`}
        />
      ) : null}
      {submission ? (
        <>
          <div className="flex items-center justify-between gap-2">
            <span className="flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Smartphone className="size-4 text-muted" aria-hidden />
              Sent from the driver app
            </span>
            <Badge tone="info" size="sm">{`Submission ${submission.submissionNumber}`}</Badge>
          </div>
          <p className="text-xs text-muted">
            {submission.driverName} · {formatDateTime(submission.submittedAt)} · truck {submission.truckUnit}
            {submission.trailerUnit ? ` · trailer ${submission.trailerUnit}` : ''}
            {submission.odometer != null ? ` · ${submission.odometer.toLocaleString('en-US')} mi` : ''}
            {submission.photos.length ? ` · ${submission.photos.length} photo${submission.photos.length === 1 ? '' : 's'}` : ''}
          </p>
          {flagged.length > 0 ? (
            <ul className="flex flex-col gap-1">
              {flagged.map((item) => (
                <li key={item.key} className="flex items-start gap-2 text-xs">
                  <Badge tone={item.result === 'defect' ? 'danger' : 'warning'} size="sm">
                    {DRIVER_PTI_RESULT_LABEL[item.result]}
                  </Badge>
                  <span className="text-ink">
                    {item.key.replace(/_/g, ' ')}
                    {item.note ? <span className="text-muted"> · {item.note}</span> : null}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted">Every checklist item marked Good.</p>
          )}
          {submission.notes ? <p className="text-xs text-ink">“{submission.notes}”</p> : null}
          {history.length > 0 ? (
            <p className="text-2xs text-muted">
              {history.length} earlier submission{history.length === 1 ? '' : 's'} kept: {history.map((h) => formatDateTime(h.submittedAt)).join(', ')}
            </p>
          ) : null}
        </>
      ) : null}
      {canAsk && !asking ? (
        <div>
          <Button variant="secondary" size="sm" icon={<Undo2 />} onClick={() => setAsking(true)}>
            Request correction
          </Button>
        </div>
      ) : null}
      {canAsk && asking ? (
        <div className="flex flex-col gap-2">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="What the driver should redo" placeholder="What the driver should redo (too dark, trailer side missing…)" />
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              disabled={reason.trim().length < 3 || request.isPending}
              loading={request.isPending}
              onClick={() =>
                request.mutate(
                  { id: inspection.id, version: inspection.version, reason: reason.trim() },
                  {
                    onSuccess: () => {
                      setAsking(false);
                      setReason('');
                      toast({ tone: 'success', title: 'Correction requested', description: 'The driver is told why in the app and sends it again.' });
                    },
                    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not sent', description: e instanceof Error ? e.message : undefined }),
                  },
                )
              }
            >
              Send to the driver
            </Button>
            <Button variant="secondary" size="sm" onClick={() => { setAsking(false); setReason(''); }}>
              Cancel
            </Button>
          </div>
        </div>
      ) : null}
    </section>
  );
}
