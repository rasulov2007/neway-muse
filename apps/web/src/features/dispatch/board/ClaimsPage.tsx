import { Download, Plus, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { DISPATCH_CLAIM_STATUSES, DISPATCH_CLAIM_TYPES, type Claim } from '@neway/shared';
import { Alert, Badge, Button, FormField, Input, Modal, Select, Textarea, cn, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { useClaims, useVoidClaim, useWriteClaim } from './api';
import { AccessPill, BoardBar } from './chrome';
import { GRID, cents } from './sheet';

const TH = cn(GRID.headNavy, 'h-8');
const TD = 'h-8 border-r border-b border-nw-border-strong bg-nw-panel px-2 text-center align-middle text-[12.5px] text-nw-text';
const STATUS_TONE: Record<Claim['status'], 'neutral' | 'info' | 'success' | 'warning' | 'danger'> = { open: 'neutral', submitted: 'info', recovered: 'success', partial: 'warning', denied: 'danger', paid: 'success' };

/**
 * Detention & Layover (owner's brief §13): one claim per load number - type, driver, date,
 * requested, recovered, updater and their payout, status, notes - with totals and a CSV export.
 * Admins edit; everyone else reads. Recovered money never enters dispatcher commission.
 */
export function ClaimsPage() {
  const account = useAccount();
  const canManage = account?.permissions.includes('dispatch.manage') ?? false;
  const claims = useClaims();
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Claim | null | false>(false);
  const needle = q.trim().toLowerCase();
  const rows = useMemo(() => (claims.data ?? []).filter((c) => !needle || [c.loadNumber, c.driverName, c.updater, c.notes, c.status, c.claimType].join(' ').toLowerCase().includes(needle)), [claims.data, needle]);
  const totals = rows.reduce((t, c) => ({ requested: t.requested + c.requestedCents, recovered: t.recovered + c.recoveredCents, payout: t.payout + c.updaterPayoutCents }), { requested: 0, recovered: 0, payout: 0 });
  const exportCsv = () => {
    const head = ['Load #', 'Type', 'Driver', 'Date', 'Requested', 'Recovered', 'Updater', 'Updater payout', 'Status', 'Notes'];
    const lines = rows.map((c) => [c.loadNumber, c.claimType, c.driverName, c.claimDate, (c.requestedCents / 100).toFixed(2), (c.recoveredCents / 100).toFixed(2), c.updater, (c.updaterPayoutCents / 100).toFixed(2), c.status, c.notes]);
    const csv = [head, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `detention-layover-${companyToday()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  return (
    <div className="flex flex-col gap-2">
      <BoardBar current="/dispatch/claims" title="Detention & Layover" meta={claims.data ? `${claims.data.length} claims` : 'Loading…'}>
        <AccessPill canWrite={canManage} canManage={canManage} />
        <Input size="sm" type="search" prefix={<Search />} aria-label="Search claims" placeholder="Search load, driver, updater…" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
        <Button variant="secondary" size="sm" icon={<Download />} onClick={exportCsv} disabled={rows.length === 0}>
          CSV
        </Button>
        {canManage ? (
          <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setEditing(null)}>
            New claim
          </Button>
        ) : null}
      </BoardBar>
      {claims.isError ? <Alert tone="danger">Claims could not be loaded.</Alert> : null}
      <div className={GRID.frame}>
        <table className="nw-board w-full min-w-[1100px] border-collapse">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className={TH}>Load #</th>
              <th className={TH}>Type</th>
              <th className={TH}>Driver</th>
              <th className={TH}>Date</th>
              <th className={TH}>Requested</th>
              <th className={TH}>Recovered</th>
              <th className={TH}>Updater</th>
              <th className={TH}>Updater payout</th>
              <th className={TH}>Status</th>
              <th className={cn(TH, 'border-r-0')}>Notes</th>
            </tr>
          </thead>
          <tbody>
            {claims.isPending ? (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-nw-text-3">
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-nw-text-3">
                  No claims yet.
                </td>
              </tr>
            ) : (
              rows.map((c) => (
                <tr key={c.id} className={canManage ? 'cursor-pointer hover:[&>td]:bg-nw-hover' : undefined} onClick={() => canManage && setEditing(c)}>
                  <td className={cn(TD, 'font-bold')}>{c.loadNumber}</td>
                  <td className={cn(TD, 'capitalize')}>{c.claimType}</td>
                  <td className={TD}>{c.driverName}</td>
                  <td className={cn(TD, 'tabular')}>{c.claimDate}</td>
                  <td className={cn(TD, 'tabular')}>{cents(c.requestedCents)}</td>
                  <td className={cn(TD, 'tabular font-semibold')}>{cents(c.recoveredCents)}</td>
                  <td className={TD}>{c.updater}</td>
                  <td className={cn(TD, 'tabular')}>{cents(c.updaterPayoutCents)}</td>
                  <td className={TD}>
                    <Badge tone={STATUS_TONE[c.status]} size="sm" dot>
                      {c.status}
                    </Badge>
                  </td>
                  <td className={cn(TD, 'max-w-0 truncate border-r-0 text-left text-nw-text-2')} title={c.notes}>
                    {c.notes}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr className={GRID.grand}>
              <td className={cn(GRID.grandCell, 'text-left')} colSpan={4}>
                Total · {rows.length} claims
              </td>
              <td className={GRID.grandCell}>{cents(totals.requested)}</td>
              <td className={GRID.grandCell}>{cents(totals.recovered)}</td>
              <td className={GRID.grandCell} />
              <td className={GRID.grandCell}>{cents(totals.payout)}</td>
              <td className={cn(GRID.grandCell, 'border-r-0')} colSpan={2} />
            </tr>
          </tfoot>
        </table>
      </div>
      {editing !== false ? <ClaimDialog claim={editing} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

function ClaimDialog({ claim, onClose }: { claim: Claim | null; onClose: () => void }) {
  const write = useWriteClaim();
  const voidClaim = useVoidClaim();
  const { toast } = useToast();
  const [f, setF] = useState({
    loadNumber: claim?.loadNumber ?? '',
    claimType: claim?.claimType ?? 'detention',
    driverName: claim?.driverName ?? '',
    claimDate: claim?.claimDate ?? companyToday(),
    requested: claim ? (claim.requestedCents / 100).toFixed(2) : '',
    recovered: claim ? (claim.recoveredCents / 100).toFixed(2) : '',
    updater: claim?.updater ?? '',
    payout: claim ? (claim.updaterPayoutCents / 100).toFixed(2) : '',
    status: claim?.status ?? 'open',
    notes: claim?.notes ?? '',
  });
  const [error, setError] = useState<string | null>(null);
  const money = (s: string) => Math.round((Number(s.replace(/[$,]/g, '')) || 0) * 100);
  const submit = async () => {
    setError(null);
    try {
      await write.mutateAsync({
        id: claim?.id ?? null,
        loadNumber: f.loadNumber.trim(),
        claimType: f.claimType as Claim['claimType'],
        driverName: f.driverName.trim(),
        claimDate: f.claimDate,
        requestedCents: money(f.requested),
        recoveredCents: money(f.recovered),
        updater: f.updater.trim(),
        updaterPayoutCents: money(f.payout),
        status: f.status as Claim['status'],
        notes: f.notes.trim(),
        expectedVersion: claim?.version ?? null,
      });
      toast({ tone: 'success', title: claim ? 'Claim updated' : 'Claim recorded' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not saved');
    }
  };
  const doVoid = async () => {
    if (!claim) return;
    const reason = window.prompt('Why is this claim voided? (kept on the audit)');
    if (!reason) return;
    try {
      await voidClaim.mutateAsync({ id: claim.id, reason, expectedVersion: claim.version });
      toast({ tone: 'success', title: 'Claim voided' });
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Not voided');
    }
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={claim ? `Claim · load ${claim.loadNumber}` : 'New claim'}
      description="One claim per load number. Recovered money is accessorial: it never enters the linehaul gross dispatcher commission is paid on."
      footer={
        <>
          {claim ? (
            <Button variant="danger" onClick={() => void doVoid()} loading={voidClaim.isPending}>
              Void
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={write.isPending} onClick={() => void submit()}>
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-3">
        <FormField label="Load #" required>
          <Input value={f.loadNumber} onChange={(e) => setF({ ...f, loadNumber: e.target.value })} />
        </FormField>
        <FormField label="Type">
          <Select options={DISPATCH_CLAIM_TYPES.map((t) => ({ value: t, label: t }))} value={f.claimType} onValueChange={(v) => setF({ ...f, claimType: v as Claim['claimType'] })} />
        </FormField>
        <FormField label="Date">
          <Input type="date" value={f.claimDate} onChange={(e) => setF({ ...f, claimDate: e.target.value })} />
        </FormField>
        <FormField label="Driver">
          <Input value={f.driverName} onChange={(e) => setF({ ...f, driverName: e.target.value })} />
        </FormField>
        <FormField label="Requested $">
          <Input value={f.requested} onChange={(e) => setF({ ...f, requested: e.target.value })} />
        </FormField>
        <FormField label="Recovered $">
          <Input value={f.recovered} onChange={(e) => setF({ ...f, recovered: e.target.value })} />
        </FormField>
        <FormField label="Updater">
          <Input value={f.updater} onChange={(e) => setF({ ...f, updater: e.target.value })} />
        </FormField>
        <FormField label="Updater payout $">
          <Input value={f.payout} onChange={(e) => setF({ ...f, payout: e.target.value })} />
        </FormField>
        <FormField label="Status">
          <Select options={DISPATCH_CLAIM_STATUSES.map((s) => ({ value: s, label: s }))} value={f.status} onValueChange={(v) => setF({ ...f, status: v as Claim['status'] })} />
        </FormField>
        <FormField label="Notes" className="sm:col-span-3">
          <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </FormField>
      </div>
      {error ? (
        <Alert tone="danger" className="mt-3">
          {error}
        </Alert>
      ) : null}
    </Modal>
  );
}
