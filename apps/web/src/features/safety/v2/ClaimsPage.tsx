import { Link, useNavigate } from '@tanstack/react-router';
import { Clock, DollarSign, FolderOpen, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { CLAIM_KINDS, CLAIM_KIND_LABEL, CLAIM_STAGES, CLAIM_STAGE_LABEL, type ClaimKind, type SafetyClaim } from '@neway/shared';
import { Badge, Button, Checkbox, Combobox, FormField, Input, Modal, Select, StatusBadge, Textarea } from '@/design-system';
import { safetyApi, useAccidents, useCan, useClaims, useSafetyPickers, useSafetyWrite } from './api';
import { CountTile, LoadError, Loading, OwnerCell, Panel, SafetyTitle, Sub, money, td, th } from './ui';

export const claimStageStatus = (c: Pick<SafetyClaim, 'stage'>) => (c.stage === 'closed' ? 'closed' : c.stage === 'submitted' ? 'submitted' : c.stage);

/** Claims, as the owner's mockup draws them: three counts, four filters, one row per claim. */
export function ClaimsV2Page() {
  const list = useClaims();
  const canWrite = useCan('safety.manage');
  const [creating, setCreating] = useState(false);
  const [kind, setKind] = useState('all');
  const [stage, setStage] = useState('all');
  const [insurer, setInsurer] = useState('all');
  const [owner, setOwner] = useState('all');
  const rows = list.data ?? [];
  const insurers = useMemo(() => [...new Set(rows.map((r) => r.insurer).filter((v): v is string => Boolean(v)))], [rows]);
  const owners = useMemo(() => [...new Set(rows.map((r) => r.ownerName).filter((v): v is string => Boolean(v)))], [rows]);
  const shown = rows.filter(
    (r) => (kind === 'all' || r.kind === kind) && (stage === 'all' || r.stage === stage) && (insurer === 'all' || r.insurer === insurer) && (owner === 'all' || r.ownerName === owner),
  );
  const tile = (n: number) => (list.data ? n : null);

  return (
    <div className="flex w-full flex-col gap-4">
      {creating ? <NewClaimDialog open={creating} onOpenChange={setCreating} /> : null}
      <div className="text-xs text-nw-text-3">Safety &amp; Compliance / Claims</div>
      <SafetyTitle
        title="Claims"
        subtitle="Manage insurance claims and related incidents, loads, and costs."
        actions={
          canWrite ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>
              New claim
            </Button>
          ) : null
        }
      />
      <div className="grid gap-3 md:grid-cols-3">
        <CountTile icon={<FolderOpen />} tone="urgent" value={tile(rows.filter((r) => r.stage !== 'closed').length)} label="Open" />
        <CountTile icon={<Clock />} tone="warning" value={tile(rows.filter((r) => r.stage === 'submitted' || r.stage === 'insurer_review' || r.stage === 'decision').length)} label="Awaiting insurer" />
        <CountTile icon={<DollarSign />} tone="done" value={tile(rows.filter((r) => r.stage === 'payment').length)} label="Payment pending" />
      </div>
      <Panel>
        <div className="grid items-end gap-3 md:grid-cols-[repeat(4,minmax(0,1fr))_auto]">
          <FormField label="Type">
            <Select value={kind} onValueChange={setKind} options={[{ value: 'all', label: 'All types' }, ...CLAIM_KINDS.map((k) => ({ value: k, label: CLAIM_KIND_LABEL[k] }))]} />
          </FormField>
          <FormField label="Status">
            <Select value={stage} onValueChange={setStage} options={[{ value: 'all', label: 'All statuses' }, ...CLAIM_STAGES.map((s) => ({ value: s, label: CLAIM_STAGE_LABEL[s] }))]} />
          </FormField>
          <FormField label="Insurer">
            <Select value={insurer} onValueChange={setInsurer} options={[{ value: 'all', label: 'All insurers' }, ...insurers.map((i) => ({ value: i, label: i }))]} />
          </FormField>
          <FormField label="Owner">
            <Select value={owner} onValueChange={setOwner} options={[{ value: 'all', label: 'All owners' }, ...owners.map((o) => ({ value: o, label: o }))]} />
          </FormField>
          <Button
            variant="outline"
            onClick={() => {
              setKind('all');
              setStage('all');
              setInsurer('all');
              setOwner('all');
            }}
          >
            Clear filters
          </Button>
        </div>
      </Panel>
      <Panel padding="none">
        {list.isLoading ? <Loading /> : list.error ? <LoadError error={list.error} /> : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[960px] border-collapse">
              <thead className="border-b border-nw-border bg-nw-subtle">
                <tr>
                  <th className={th}>Claim</th>
                  <th className={th}>Linked incident / load</th>
                  <th className={th}>Type</th>
                  <th className={th}>Driver &amp; truck</th>
                  <th className={th}>Insurer</th>
                  <th className={th}>Stage</th>
                  <th className={th}>Amount</th>
                  <th className={th}>Next action</th>
                  <th className={th}>Owner</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nw-border">
                {shown.length === 0 ? (
                  <tr>
                    <td colSpan={9} className="px-3 py-10 text-center text-sm text-nw-text-3">
                      {rows.length === 0 ? 'No claims recorded.' : 'No claims match these filters.'}
                    </td>
                  </tr>
                ) : (
                  shown.map((c) => (
                    <tr key={c.id} className="hover:bg-nw-hover">
                      <td className={td}>
                        <Link to="/safety/claims/$claimId" params={{ claimId: c.id }} className="font-semibold text-nw-accent-ink underline underline-offset-2">
                          {c.number}
                        </Link>
                        {c.isTest ? <Badge size="sm" className="ml-1">Test</Badge> : null}
                      </td>
                      <td className={td}>
                        {c.accidentId ? (
                          <Link to="/safety/accidents/$accidentId" params={{ accidentId: c.accidentId }} className="font-semibold text-nw-accent-ink underline underline-offset-2">
                            {c.accidentNumber}
                          </Link>
                        ) : (
                          <span className="text-nw-text-3">None</span>
                        )}
                        {c.loadNumber ? <Sub>Load: {c.loadNumber}</Sub> : null}
                      </td>
                      <td className={td}>{CLAIM_KIND_LABEL[c.kind]}</td>
                      <td className={td}>
                        {c.driverName ?? <span className="text-nw-text-3">Not named</span>}
                        {c.truckNumber ? <Sub>Unit {c.truckNumber}</Sub> : null}
                      </td>
                      <td className={td}>{c.insurer ?? <span className="text-nw-text-3">Not named</span>}</td>
                      <td className={td}>
                        <StatusBadge status={claimStageStatus(c)} label={c.stage === 'insurer_review' ? 'Under review' : CLAIM_STAGE_LABEL[c.stage]} />
                      </td>
                      <td className={td}>{money(c.claimedCents)}</td>
                      <td className={td}>{c.nextAction ?? <span className="text-nw-text-3">None</span>}</td>
                      <td className={td}>
                        <OwnerCell name={c.ownerName} />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
      {list.data ? (
        <div className="text-right text-xs text-nw-text-3">
          Showing {shown.length} of {rows.length} claims
        </div>
      ) : null}
    </div>
  );
}

/** Opens a claim from an accident, from a load (cargo), or on its own. */
export function NewClaimDialog({ open, onOpenChange, accidentId }: { open: boolean; onOpenChange: (o: boolean) => void; accidentId?: string }) {
  const navigate = useNavigate();
  const pickers = useSafetyPickers();
  const accidents = useAccidents();
  const [kind, setKind] = useState<ClaimKind>('physical_damage');
  const [fromAccident, setFromAccident] = useState<string | null>(accidentId ?? null);
  const [loadId, setLoadId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [truckId, setTruckId] = useState<string | null>(null);
  const [insurer, setInsurer] = useState('');
  const [policy, setPolicy] = useState('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [isTest, setIsTest] = useState(false);
  const save = useSafetyWrite(
    () =>
      safetyApi.post<{ claim: SafetyClaim; created: boolean }>('/claims', {
        kind,
        accidentId: fromAccident,
        loadId,
        driverId: fromAccident ? undefined : driverId,
        truckId: fromAccident ? undefined : truckId,
        insurer: insurer.trim() || null,
        policyNumber: policy.trim() || null,
        claimedCents: amount.trim() ? Math.round(Number(amount) * 100) : null,
        description: description.trim(),
        isTest,
      }),
    (r) => (r.created ? `Claim ${r.claim.number} opened` : `Claim ${r.claim.number} is already open for that accident`),
  );
  const accidentOptions = (accidents.data ?? []).filter((a) => !a.voidedAt).map((a) => ({ value: a.id, label: `${a.number} · ${a.driverName ?? 'no driver'}${a.claimNumber ? ` (claim ${a.claimNumber})` : ''}` }));
  const cargoNeedsLoad = kind === 'cargo' && !loadId && !fromAccident;
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title="New claim"
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={cargoNeedsLoad}
            loading={save.isPending}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: (r) => {
                  onOpenChange(false);
                  void navigate({ to: '/safety/claims/$claimId', params: { claimId: r.claim.id } });
                },
              })
            }
          >
            Open claim
          </Button>
        </>
      }
    >
      <div className="grid gap-3 md:grid-cols-2">
        <FormField label="Type" required>
          <Select value={kind} onValueChange={(v) => setKind(v as ClaimKind)} options={CLAIM_KINDS.map((k) => ({ value: k, label: CLAIM_KIND_LABEL[k] }))} />
        </FormField>
        <FormField label="From accident" description="One accident has one claim; choosing one already claimed opens that claim.">
          <Combobox options={accidentOptions} value={fromAccident} loading={accidents.isLoading} placeholder="None" onValueChange={setFromAccident} />
        </FormField>
        <FormField label="Load" description={kind === 'cargo' ? 'A cargo claim names the load.' : undefined}>
          <Combobox options={(pickers.data?.loads ?? []).map((l) => ({ value: l.id, label: l.number }))} value={loadId} loading={pickers.isLoading} placeholder="None" onValueChange={setLoadId} />
        </FormField>
        {!fromAccident ? (
          <>
            <FormField label="Driver">
              <Combobox options={(pickers.data?.drivers ?? []).map((d) => ({ value: d.id, label: d.name }))} value={driverId} loading={pickers.isLoading} placeholder="None" onValueChange={setDriverId} />
            </FormField>
            <FormField label="Truck">
              <Combobox options={(pickers.data?.trucks ?? []).map((t) => ({ value: t.id, label: `Unit ${t.number}` }))} value={truckId} loading={pickers.isLoading} placeholder="None" onValueChange={setTruckId} />
            </FormField>
          </>
        ) : null}
        <FormField label="Insurer">
          <Input value={insurer} onChange={(e) => setInsurer(e.target.value)} />
        </FormField>
        <FormField label="Policy number">
          <Input value={policy} onChange={(e) => setPolicy(e.target.value)} />
        </FormField>
        <FormField label="Claimed amount ($)">
          <Input prefix="$" type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </FormField>
        <FormField label="Description" className="md:col-span-2">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </FormField>
        <Checkbox checked={isTest} onCheckedChange={(v) => setIsTest(v === true)} label="Test data (kept, never counted in a total)" />
      </div>
    </Modal>
  );
}
