import { AlertTriangle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, Modal } from '@/design-system';
import { apiGet, apiPut } from '@/lib/api-client';
import { BASE, problemText, useAccWrite } from './api';
import { centsToDollars, dollarsToCents } from './claims-api';
import { Field, LoadError, Loading, NInput, NSelect } from './ui';

const DEPTS: readonly R.Dept[] = ['Safety', 'Fleet', 'Dispatch', 'Claims', 'Accounting', 'Management', 'Driver Relations'];
const TYPES: R.ClaimType[] = ['physical_damage', 'auto_liability', 'cargo', 'recovery', 'workers_comp'];
const DEDUCTIBLES = [
  ['physicalDamageDeductibleCents', 'Physical damage'],
  ['autoLiabilityDeductibleCents', 'Auto liability (also workers’ comp)'],
  ['cargoDeductibleCents', 'Cargo'],
] as const;
type DeductibleKey = (typeof DEDUCTIBLES)[number][0];

export const useAccidentSettings = (enabled: boolean) =>
  useQuery({ queryKey: ['accidents-v2', 'settings'], queryFn: () => apiGet<A.AccidentSettingsResponse>(`${BASE}/settings`), enabled });

/**
 * Accidents settings (go-live, IMPLEMENTATION-PLAN §17 item 8): who gets a department's tasks by default, the default
 * insurer per coverage and the deductibles — the carrier's own values, entered by Safety. Read-only for everyone
 * without `accidents.override`. The lost-revenue fallback per truck-day is shown, not edited here.
 */
export function AccidentSettingsDialog({ onClose }: { onClose: () => void }) {
  const q = useAccidentSettings(true);
  const s = q.data;
  const [dept, setDept] = useState<Record<string, string>>({});
  const [insurers, setInsurers] = useState<Record<string, string>>({});
  const [deductibles, setDeductibles] = useState<Record<DeductibleKey, string>>({ physicalDamageDeductibleCents: '', autoLiabilityDeductibleCents: '', cargoDeductibleCents: '' });
  const [error, setError] = useState('');
  useEffect(() => {
    if (!s) return;
    setDept(Object.fromEntries(DEPTS.map((d) => [d, s.deptAssignees[d]?.id ?? ''])));
    setInsurers(Object.fromEntries(TYPES.map((t) => [t, s.insurers[t] ?? ''])));
    setDeductibles({
      physicalDamageDeductibleCents: centsToDollars(s.deductibles.physicalDamageDeductibleCents),
      autoLiabilityDeductibleCents: centsToDollars(s.deductibles.autoLiabilityDeductibleCents),
      cargoDeductibleCents: centsToDollars(s.deductibles.cargoDeductibleCents),
    });
  }, [s]);
  const save = useAccWrite((body: A.AccidentSettingsInput) => apiPut<A.AccidentSettingsResponse>(`${BASE}/settings`, body), 'Accidents settings saved');
  const editable = Boolean(s?.canEdit);

  const submit = () => {
    if (!s) return;
    const d: Partial<Record<DeductibleKey, number>> = {};
    for (const [k, label] of DEDUCTIBLES) {
      const c = dollarsToCents(deductibles[k]);
      if (c === null) return setError(`${label}: enter an amount in dollars`);
      d[k] = c;
    }
    setError('');
    save.mutate(
      {
        version: s.version,
        deptAssignees: Object.fromEntries(DEPTS.map((x) => [x, dept[x] || null])),
        insurers: Object.fromEntries(TYPES.map((t) => [t, insurers[t] ?? ''])),
        deductibles: d,
      },
      { onSuccess: onClose, onError: (e) => setError(problemText(e)) },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="lg"
      title="Accidents settings"
      description="Your company’s own values: who picks up each department’s tasks, your insurer for each coverage and your deductibles. Nothing is filled in for you."
      footer={
        <>
          {error ? (
            <span className="mr-auto inline-flex items-center gap-1 text-xs font-semibold text-nw-urgent-text" role="alert">
              <AlertTriangle className="size-3.5" aria-hidden />
              {error}
            </span>
          ) : (
            <span className="mr-auto text-xs text-nw-text-3">{s?.updatedBy ? `Last saved by ${s.updatedBy}` : ''}</span>
          )}
          <Button variant="secondary" onClick={onClose}>
            {editable ? 'Cancel' : 'Close'}
          </Button>
          {editable ? (
            <Button variant="primary" loading={save.isPending} onClick={submit} id="save-accident-settings">
              Save settings
            </Button>
          ) : null}
        </>
      }
    >
      {q.isLoading ? (
        <Loading />
      ) : q.error || !s ? (
        <LoadError error={q.error ?? new Error('Not found')} />
      ) : (
        <div className="flex flex-col gap-5" id="accident-settings">
          {!editable ? <p className="text-xs text-nw-text-3">Only Safety Managers and the owner change these.</p> : null}
          <section className="flex flex-col gap-2">
            <h3 className="text-[13px] font-bold text-nw-text">Default assignee per department</h3>
            <p className="text-xs text-nw-text-3">New tasks for a department go to this person. Left empty, Safety tasks go to the reporter and other departments’ tasks wait in the department queue.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {DEPTS.map((d) => (
                <Field key={d} label={d} htmlFor={`assignee-${d}`}>
                  <NSelect id={`assignee-${d}`} value={dept[d] ?? ''} onChange={(v) => setDept((x) => ({ ...x, [d]: v }))} disabled={!editable}>
                    <option value="">Department queue (no default)</option>
                    {s.people.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </NSelect>
                </Field>
              ))}
            </div>
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-[13px] font-bold text-nw-text">Default insurer per coverage</h3>
            <p className="text-xs text-nw-text-3">Prefilled on a new claim; it can be changed on each claim. Empty = left blank on the claim.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              {TYPES.map((t) => (
                <Field key={t} label={R.CLAIM_TYPE_LABEL[t]} htmlFor={`insurer-${t}`}>
                  <NInput id={`insurer-${t}`} value={insurers[t] ?? ''} maxLength={160} onChange={(e) => setInsurers((x) => ({ ...x, [t]: e.target.value }))} disabled={!editable} placeholder={t === 'recovery' ? 'Other party’s insurer' : 'Not set'} />
                </Field>
              ))}
            </div>
          </section>
          <section className="flex flex-col gap-2">
            <h3 className="text-[13px] font-bold text-nw-text">Deductibles</h3>
            <div className="grid gap-3 sm:grid-cols-3">
              {DEDUCTIBLES.map(([k, label]) => (
                <Field key={k} label={label} htmlFor={`deductible-${k}`}>
                  <NInput id={`deductible-${k}`} inputMode="decimal" value={deductibles[k]} onChange={(e) => setDeductibles((x) => ({ ...x, [k]: e.target.value }))} disabled={!editable} />
                </Field>
              ))}
            </div>
          </section>
          <p className="text-xs text-nw-text-3">
            Lost revenue for a truck with no daily contribution of its own: <b className="tabular text-nw-text-2">{R.money(s.fallbackDailyContributionCents)}</b> per truck-day.
          </p>
        </div>
      )}
    </Modal>
  );
}
