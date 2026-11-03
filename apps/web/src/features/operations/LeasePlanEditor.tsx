import { LEASE_PLAN_KINDS, LEASE_PLAN_LABEL, defaultLeasePlan, type LeasePlan, type LeasePlanKind } from '@neway/shared';
import { Checkbox, FormField, Input, Select, Switch } from '@/design-system';
import { formatMoney } from '@/lib/format';

const dollars = (cents: number) => String(Math.round(cents) / 100);
const toCents = (value: string) => Math.max(0, Math.round((Number(value) || 0) * 100));

/**
 * The lease sheet on a driver's financial profile (owner, 2026-10-12): which plan, the tractor
 * lease by odometer tier, the optional dispatch fee, the maintenance fee per mile and the fixed
 * weekly / monthly charges. Every line can be switched off or changed for this driver.
 */
export function LeasePlanEditor({ value, onChange }: { value: LeasePlan | null; onChange: (next: LeasePlan | null) => void }) {
  const set = (patch: Partial<LeasePlan>) => value && onChange({ ...value, ...patch });
  return (
    <div className="md:col-span-2 flex flex-col gap-3 rounded-lg border border-line p-3" data-testid="lease-plan-editor">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-semibold text-ink">Lease charges</p>
          <p className="text-2xs text-muted">Taken on each settlement. The tractor lease tier and the maintenance fee follow the truck’s Samsara odometer.</p>
        </div>
        <div className="w-56">
          <Select
            aria-label="Lease plan"
            value={value?.kind ?? 'none'}
            onValueChange={(v) => onChange(v === 'none' ? null : defaultLeasePlan(v as LeasePlanKind))}
            options={[{ value: 'none', label: 'No lease charges' }, ...LEASE_PLAN_KINDS.map((k) => ({ value: k, label: LEASE_PLAN_LABEL[k] }))]}
          />
        </div>
      </div>
      {value ? (
        <>
          <div className="flex flex-col gap-2 rounded-lg bg-surface-muted p-3">
            <Switch checked={value.tractorLease.enabled} onCheckedChange={(v) => set({ tractorLease: { ...value.tractorLease, enabled: v } })} label="Tractor lease (weekly, by odometer)" />
            {value.tractorLease.enabled ? (
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {value.tractorLease.tiers.map((t, i) => {
                  const from = i === 0 ? 0 : (value.tractorLease.tiers[i - 1]?.upToMiles ?? 0) + 1;
                  return (
                    <FormField key={i} label={`Tier ${i + 1}: ${from.toLocaleString('en-US')}${t.upToMiles === null ? ' mi and more' : ` – ${t.upToMiles.toLocaleString('en-US')} mi`} ($/week)`}>
                      <Input
                        type="number"
                        step="1"
                        aria-label={`Tier ${i + 1} weekly`}
                        value={dollars(t.weeklyCents)}
                        onChange={(e) => set({ tractorLease: { ...value.tractorLease, tiers: value.tractorLease.tiers.map((x, j) => (j === i ? { ...x, weeklyCents: toCents(e.target.value) } : x)) } })}
                      />
                    </FormField>
                  );
                })}
              </div>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-2 rounded-lg bg-surface-muted p-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              <Switch checked={value.dispatchFee.enabled} onCheckedChange={(v) => set({ dispatchFee: { ...value.dispatchFee, enabled: v } })} label="Dispatch fee (% of gross, weekly)" />
            </div>
            {value.dispatchFee.enabled ? (
              <FormField label="Dispatch fee (%)">
                <Input type="number" step="0.1" aria-label="Dispatch fee percent" value={String(value.dispatchFee.percent)} onChange={(e) => set({ dispatchFee: { ...value.dispatchFee, percent: Math.min(100, Math.max(0, Number(e.target.value) || 0)) } })} />
              </FormField>
            ) : null}
          </div>
          <div className="grid grid-cols-1 gap-2 rounded-lg bg-surface-muted p-3 sm:grid-cols-3">
            <div className="sm:col-span-3">
              <Switch checked={value.maintenanceFee.enabled} onCheckedChange={(v) => set({ maintenanceFee: { ...value.maintenanceFee, enabled: v } })} label="Maintenance fee (per mile driven in the week)" />
            </div>
            {value.maintenanceFee.enabled ? (
              <>
                <FormField label="Rate ($/mile)">
                  <Input prefix="$" type="number" step="0.01" aria-label="Maintenance rate" value={dollars(value.maintenanceFee.centsPerMile)} onChange={(e) => set({ maintenanceFee: { ...value.maintenanceFee, centsPerMile: toCents(e.target.value) } })} />
                </FormField>
                <FormField label="Past the threshold ($/mile)">
                  <Input prefix="$" type="number" step="0.01" aria-label="Maintenance high rate" value={dollars(value.maintenanceFee.highCentsPerMile)} onChange={(e) => set({ maintenanceFee: { ...value.maintenanceFee, highCentsPerMile: toCents(e.target.value) } })} />
                </FormField>
                <FormField label="Threshold (odometer mi)">
                  <Input type="number" step="1000" aria-label="Maintenance threshold" value={String(value.maintenanceFee.thresholdMiles)} onChange={(e) => set({ maintenanceFee: { ...value.maintenanceFee, thresholdMiles: Math.max(0, Math.round(Number(e.target.value) || 0)) } })} />
                </FormField>
              </>
            ) : null}
          </div>
          <div className="flex flex-col gap-1.5 rounded-lg bg-surface-muted p-3">
            <p className="text-xs font-semibold text-ink">Fixed charges</p>
            {value.fixedCharges.map((c, i) => (
              <div key={c.code} className="flex flex-wrap items-center gap-3">
                <div className="min-w-0 flex-1">
                  <Checkbox checked={c.enabled} onCheckedChange={(v) => set({ fixedCharges: value.fixedCharges.map((x, j) => (j === i ? { ...x, enabled: v === true } : x)) })} label={`${c.label} · ${c.cadence}`} />
                </div>
                <div className="w-28">
                  <Input prefix="$" type="number" step="1" aria-label={`${c.label} amount`} value={dollars(c.cents)} disabled={!c.enabled} onChange={(e) => set({ fixedCharges: value.fixedCharges.map((x, j) => (j === i ? { ...x, cents: toCents(e.target.value) } : x)) })} />
                </div>
              </div>
            ))}
            <p className="text-2xs text-muted">
              Weekly total of the fixed charges: {formatMoney(value.fixedCharges.filter((c) => c.enabled && c.cadence === 'weekly').reduce((s, c) => s + c.cents, 0) / 100)}; monthly ones are taken in the week that holds the 1st. The security deposit is the escrow below.
            </p>
          </div>
        </>
      ) : null}
    </div>
  );
}
