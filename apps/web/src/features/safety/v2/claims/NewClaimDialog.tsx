import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import { CLAIM_KIND_OF_LINE, CLAIM_LINE_KINDS, CLAIM_LINE_KIND_LABEL, type ClaimLineKind, type SafetyClaim } from '@neway/shared';
import { Button, Checkbox, Combobox, FormField, Input, Modal, Select, Textarea } from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { safetyApi, useAccidents, useClaims, useSafetyPickers, useSafetyWrite } from '../api';

/**
 * New claim (Claims v2, owner mockup 2026-10-14): start from an accident, a load or nothing; tick
 * every kind of claim the incident brings - each becomes a line on the one claim file; an initial
 * reserve (empty = unknown exposure) and the insurer. An accident that already has a claim gets the
 * new lines on that claim instead of a second claim.
 */
const LOAD = '__load';
const MANUAL = '__manual';
const OTHER = '__other';
const NOT_FILING = '__none';

export function NewClaimDialogV2({ onClose, accidentId }: { onClose: () => void; accidentId?: string }) {
  const navigate = useNavigate();
  const accidents = useAccidents();
  const claims = useClaims();
  const pickers = useSafetyPickers();
  const [start, setStart] = useState<string>(accidentId ?? '');
  const [lines, setLines] = useState<ClaimLineKind[]>(['own_physical_damage']);
  const [reserve, setReserve] = useState('');
  const [insurer, setInsurer] = useState('');
  const [otherInsurer, setOtherInsurer] = useState('');
  const [loadId, setLoadId] = useState<string | null>(null);
  const [driverId, setDriverId] = useState<string | null>(null);
  const [truckId, setTruckId] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [isTest, setIsTest] = useState(false);

  const openAccidents = (accidents.data ?? []).filter((a) => !a.voidedAt);
  const accident = openAccidents.find((a) => a.id === start) ?? null;
  const known = new Map<string, string>();
  for (const c of claims.data ?? []) if (c.insurer && !known.has(c.insurer)) known.set(c.insurer, c.policyNumber ? `${c.insurer} · policy ${c.policyNumber}` : c.insurer);
  const insurerName = insurer === OTHER ? otherInsurer.trim() : insurer === NOT_FILING || !insurer ? null : insurer;
  const cargoNeedsLoad = lines.includes('cargo_against_us') && !accident && !loadId;
  const reserveCents = reserve.trim() ? Math.round(Number(reserve.replace(/[$,\s]/g, '')) * 100) : null;
  const ready = start !== '' && lines.length > 0 && !cargoNeedsLoad && (reserveCents === null || Number.isFinite(reserveCents));

  const save = useSafetyWrite(
    () =>
      safetyApi.post<{ claim: SafetyClaim; created: boolean }>('/claims', {
        kind: CLAIM_KIND_OF_LINE[lines[0] as ClaimLineKind],
        lines,
        accidentId: accident?.id ?? null,
        loadId: start === LOAD ? loadId : null,
        driverId: start === MANUAL ? driverId : undefined,
        truckId: start === MANUAL ? truckId : undefined,
        insurer: insurerName,
        claimedCents: reserveCents,
        description: description.trim(),
        isTest,
      }),
    (r) => (r.created ? `Claim ${r.claim.number} opened with ${lines.length} line${lines.length === 1 ? '' : 's'}` : `Lines added to ${r.claim.number}, already open for that accident`),
  );

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="New claim"
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={save.isPending}
            onClick={() =>
              save.mutate(undefined, {
                onSuccess: (r) => {
                  onClose();
                  void navigate({ to: '/safety/claims/$claimId', params: { claimId: r.claim.id } });
                },
              })
            }
            data-testid="new-claim-open"
          >
            {accident?.claimId ? 'Add lines' : 'Open claim'}
          </Button>
        </div>
      }
    >
      <div className="flex flex-col gap-4" data-testid="new-claim-dialog">
        <FormField label="Start from" description="Driver, unit, trailer, load, broker and shipper carry over.">
          <Select
            aria-label="Start from"
            value={start}
            placeholder={accidents.isLoading ? 'Loading…' : 'Pick an accident, a load or nothing…'}
            onValueChange={setStart}
            options={[
              ...openAccidents.map((a) => ({
                value: a.id,
                label: `Accident ${a.number} · ${a.truckNumber ? `Unit ${a.truckNumber}` : (a.driverName ?? 'no unit')} · ${formatIsoDate(a.occurredAt.slice(0, 10))} ${a.claimNumber ? `(claim ${a.claimNumber} · adds lines)` : '(no claim yet)'}`,
              })),
              { value: LOAD, label: 'A load · cargo exception' },
              { value: MANUAL, label: 'Nothing linked (manual)' },
            ]}
          />
        </FormField>
        {start === LOAD ? (
          <FormField label="Load" required>
            <Combobox options={(pickers.data?.loads ?? []).map((l) => ({ value: l.id, label: l.number }))} value={loadId} loading={pickers.isLoading} placeholder="Pick the load" onValueChange={setLoadId} />
          </FormField>
        ) : null}
        {start === MANUAL ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Driver">
              <Combobox options={(pickers.data?.drivers ?? []).map((d) => ({ value: d.id, label: d.name }))} value={driverId} loading={pickers.isLoading} placeholder="None" onValueChange={setDriverId} />
            </FormField>
            <FormField label="Truck">
              <Combobox options={(pickers.data?.trucks ?? []).map((t) => ({ value: t.id, label: `Unit ${t.number}` }))} value={truckId} loading={pickers.isLoading} placeholder="None" onValueChange={setTruckId} />
            </FormField>
          </div>
        ) : null}

        <fieldset className="flex flex-col gap-2.5">
          <legend className="mb-2 text-sm font-semibold text-nw-text">What kind of claim? (pick all that apply · each becomes a line)</legend>
          {CLAIM_LINE_KINDS.map((k) => (
            <Checkbox
              key={k}
              checked={lines.includes(k)}
              onCheckedChange={(v) => setLines((ls) => (v === true ? [...ls.filter((x) => x !== k), k].sort((a, b) => CLAIM_LINE_KINDS.indexOf(a) - CLAIM_LINE_KINDS.indexOf(b)) : ls.filter((x) => x !== k)))}
              label={CLAIM_LINE_KIND_LABEL[k]}
            />
          ))}
          {lines.length === 0 ? <p className="text-xs text-nw-urgent-text">Pick at least one.</p> : null}
          {cargoNeedsLoad ? <p className="text-xs text-nw-urgent-text">A cargo claim names the load (or starts from the accident).</p> : null}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Initial reserve ($)">
            <Input inputMode="decimal" value={reserve} onChange={(e) => setReserve(e.target.value)} placeholder="Leave empty = unknown exposure" />
          </FormField>
          <FormField label="Insurer">
            <Select
              aria-label="Insurer"
              value={insurer}
              placeholder="Pick the insurer…"
              onValueChange={setInsurer}
              options={[...[...known.entries()].map(([value, label]) => ({ value, label })), { value: OTHER, label: 'Other…' }, { value: NOT_FILING, label: 'Not filing (company pays)' }]}
            />
          </FormField>
        </div>
        {insurer === OTHER ? (
          <FormField label="Insurer name">
            <Input value={otherInsurer} onChange={(e) => setOtherInsurer(e.target.value)} placeholder="e.g. Prairie Mutual" />
          </FormField>
        ) : null}
        <FormField label="What happened">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder={accident ? 'Carried from the accident when left empty' : 'A line on what happened'} />
        </FormField>
        <Checkbox checked={isTest} onCheckedChange={(v) => setIsTest(v === true)} label="Test data (kept, never counted in a total)" />
        <p className="rounded-[10px] border border-nw-border bg-nw-subtle px-3 py-2 text-[13px] text-nw-text-2">Only the fields this type needs are shown. Documents required for these lines are added to the checklist automatically.</p>
      </div>
    </Modal>
  );
}
