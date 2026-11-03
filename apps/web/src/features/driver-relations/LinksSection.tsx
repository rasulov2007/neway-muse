import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import type { DriverRelationRequest } from '@neway/shared';
import { Button, Input, Modal } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { useLinkRecords, useRosterOptions } from './api';

/**
 * The records a request is tied to: the HR lead a referral created or joined, the roster driver
 * and truck somebody verified, and an Accounting reimbursement recorded in Accounting's own
 * workflow. Nothing here is matched from the name the driver typed, and nothing here moves money.
 */
export function LinksSection({ request, canContact }: { request: DriverRelationRequest; canContact: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-md border border-nw-border px-3 py-2.5 text-xs">
      <div className="flex items-center justify-between gap-2">
        <h3 className="font-semibold text-nw-text-2">Linked records</h3>
        {canContact ? (
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
            Verify / link
          </Button>
        ) : null}
      </div>
      <dl className="mt-1 grid grid-cols-1 gap-1 sm:grid-cols-2">
        <div className="flex gap-1.5">
          <dt className="text-nw-text-3">Driver:</dt>
          <dd className="text-nw-text">{request.driverName ?? 'Not verified'}</dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-nw-text-3">Truck:</dt>
          <dd className="text-nw-text">{request.truckUnit ? `Truck ${request.truckUnit}` : 'Not verified'}</dd>
        </div>
        {request.topic === 'referral' ? (
          <div className="flex gap-1.5">
            <dt className="text-nw-text-3">HR referral:</dt>
            <dd className="text-nw-text">
              {request.hrLeadNumber ? (
                <Link to="/hr/recruiting" className="text-nw-accent-ink hover:underline">
                  Lead {request.hrLeadNumber} in Recruiting
                </Link>
              ) : (
                'Not linked'
              )}
            </dd>
          </div>
        ) : null}
        {request.topic === 'reimbursement' ? (
          <div className="flex gap-1.5">
            <dt className="text-nw-text-3">Accounting:</dt>
            <dd className="text-nw-text">
              {request.accountingExpenseId ?? 'Not linked. Accounting records and approves reimbursements.'}
            </dd>
          </div>
        ) : null}
      </dl>
      {open ? <LinkModal request={request} onClose={() => setOpen(false)} /> : null}
    </div>
  );
}

function LinkModal({ request, onClose }: { request: DriverRelationRequest; onClose: () => void }) {
  const [q, setQ] = useState(request.truckNumber ?? '');
  const options = useRosterOptions(q.trim(), true);
  const link = useLinkRecords();
  const [expense, setExpense] = useState(request.accountingExpenseId ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = async (body: { driverId?: string | null; truckId?: string | null; accountingExpenseId?: string | null }) => {
    if (link.isPending) return;
    setError(null);
    try {
      await link.mutateAsync({ id: request.id, body: { ...body, expectedVersion: request.version } });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? `Not saved: ${e.message}` : 'Not saved. Try again.');
    }
  };

  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} title="Verify and link" size="md">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs text-nw-text-3">
          The driver typed “{request.submittedName}”{request.truckNumber ? `, truck ${request.truckNumber}` : ''}. Pick the roster
          record only after you have confirmed who it is.
        </p>
        <Input aria-label="Search drivers and trucks" placeholder="Name, driver #, phone or unit" value={q} onChange={(e) => setQ(e.target.value)} />
        {options.isPending ? (
          <p className="text-xs text-nw-text-3">Loading…</p>
        ) : options.isError ? (
          <p className="text-xs text-nw-urgent-text">The roster could not be loaded.</p>
        ) : (
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {(options.data ?? []).length === 0 ? <li className="text-xs text-nw-text-3">No match.</li> : null}
            {(options.data ?? []).map((o) => (
              <li key={`${o.kind}:${o.id}`} className="flex items-center justify-between gap-2 rounded-md px-2 py-1 hover:bg-nw-hover">
                <span>
                  <span className="text-nw-text">{o.label}</span>
                  {o.detail ? <span className="ml-1.5 text-2xs text-nw-text-3">{o.detail}</span> : null}
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={link.isPending}
                  onClick={() => void save(o.kind === 'driver' ? { driverId: o.id } : { truckId: o.id })}
                >
                  Link {o.kind}
                </Button>
              </li>
            ))}
          </ul>
        )}
        {request.driverId || request.truckId ? (
          <div className="flex gap-2">
            {request.driverId ? (
              <Button size="sm" variant="ghost" disabled={link.isPending} onClick={() => void save({ driverId: null })}>
                Unlink driver
              </Button>
            ) : null}
            {request.truckId ? (
              <Button size="sm" variant="ghost" disabled={link.isPending} onClick={() => void save({ truckId: null })}>
                Unlink truck
              </Button>
            ) : null}
          </div>
        ) : null}
        {request.topic === 'reimbursement' ? (
          <div className="flex flex-col gap-1.5 border-t border-nw-border pt-3">
            <label htmlFor="dr-expense" className="text-xs font-semibold text-nw-text-2">
              Accounting reimbursement id
            </label>
            <p className="text-2xs text-nw-text-3">
              Accounting records, approves and pays reimbursements in Accounting → Reimbursements. Link the one they recorded; this
              never creates or pays anything.
            </p>
            <div className="flex gap-2">
              <Input id="dr-expense" value={expense} onChange={(e) => setExpense(e.target.value)} placeholder="exp_…" />
              <Button
                size="sm"
                disabled={link.isPending}
                onClick={() => void save({ accountingExpenseId: expense.trim() || null })}
              >
                Save
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-nw-urgent-text">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
