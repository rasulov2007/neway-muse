import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { AccountingSettings } from '@neway/shared';
import { Alert, Badge, Button, Checkbox, FormField, Input, Select, useToast } from '@/design-system';
import { fetchSettings, saveSettings, type AccountingSettingsResponse } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';

/**
 * Accounting settings (§5, §8, §9, §11) and the honest state of every provider.
 *
 * A setting nobody has confirmed is blank and listed under "Needs configuration" with the
 * action it blocks. Nothing here ships a guessed number.
 */

const INTEGRATION_LABEL: Record<string, string> = { rts: 'RTS (factoring)', relay: 'Relay (fuel)', bestpass: 'BestPass (tolls)', efs: 'EFS (advances / fuel)', breakthrough_fuel: 'Breakthrough Fuel', quickbooks: 'QuickBooks', adp: 'ADP (payouts)', email: 'Email transport' };
const STATUS_LABEL: Record<string, { label: string; tone: 'success' | 'warning' | 'neutral' | 'danger' | 'info' }> = { live: { label: 'Live', tone: 'success' }, sandbox: { label: 'Sandbox', tone: 'info' }, export: { label: 'Export only', tone: 'warning' }, csv_import: { label: 'CSV import only', tone: 'warning' }, not_configured: { label: 'Not configured', tone: 'neutral' } };

export function AccountingSettingsPanel() {
  const query = useQuery({ queryKey: ['accounting', 'settings'], queryFn: fetchSettings });
  if (query.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (query.isError) return <Alert tone="danger" title="Settings could not be loaded" description={query.error instanceof Error ? query.error.message : undefined} />;
  // Keyed on the version: a save re-mounts the form on the fresh copy instead of syncing state.
  return <SettingsForm key={query.data.version} s={query.data} />;
}

/**
 * What each unresolved business value is set to now, and who decided it.
 *
 * These are the values nobody can derive from the code: a percentage that could be read two ways,
 * the clock a cutoff is measured on, the terms of a factoring agreement. Showing the value beside
 * the person who confirmed it is what makes a finalized period explainable months later — and an
 * unconfirmed value is shown as unconfirmed rather than as a number.
 */
const CONFIRMABLE: Array<{ key: string; label: string; read: (s: AccountingSettings) => string }> = [
  { key: 'factoringFeeBps', label: 'Factoring fee', read: (s) => (s.factoringFeeBps === null ? 'Not decided' : `${(s.factoringFeeBps / 100).toFixed(3).replace(/0+$/, '').replace(/\.$/, '')}% of gross`) },
  { key: 'factoringReserveBps', label: 'Factoring reserve', read: (s) => (s.factoringReserveBps === null ? 'Not decided' : `${(s.factoringReserveBps / 100)}%`) },
  { key: 'cutoffBasis', label: 'Statement cutoff basis', read: (s) => (s.cutoffBasis === null ? 'Not decided' : s.cutoffBasis === 'delivered_at' ? 'Delivery time' : 'Status change time') },
  { key: 'cutoffTimezoneConfirmed', label: 'Cutoff clock', read: (s) => (s.cutoffTimezoneConfirmed === true ? 'US Eastern, confirmed' : 'Not confirmed') },
  { key: 'payPeriodCutoffTime', label: 'Pay week', read: (s) => `Monday ${s.payPeriodCutoffTime} to Monday ${s.payPeriodCutoffTime}, US Eastern` },
  { key: 'payDay', label: 'Payday', read: (s) => s.payDay },
  { key: 'payOnFundingOnly', label: 'Pay only once funded', read: (s) => (s.payOnFundingOnly === null ? 'Not decided' : s.payOnFundingOnly ? 'Yes' : 'No') },
  { key: 'teamBaseMileageSplit', label: 'Team mileage split', read: (s) => (s.teamBaseMileageSplit === null ? 'Not decided' : s.teamBaseMileageSplit === 'each_full' ? 'Each driver in full' : 'Split between drivers') },
  { key: 'vendorDefaultPercentBps', label: 'Vendor default share', read: (s) => (s.vendorDefaultPercentBps === null ? 'Not decided' : `${s.vendorDefaultPercentBps / 100}%`) },
  { key: 'quickbooksOwnsPostings', label: 'Who owns postings', read: (s) => (s.quickbooksOwnsPostings === null ? 'Not decided' : s.quickbooksOwnsPostings ? 'QuickBooks' : 'This ledger') },
];

function ConfirmedValues({ settings, confirmations, history }: { settings: AccountingSettings; confirmations: Record<string, { at: string; by: string; note: string }>; history: Array<{ at: string; by: string; changed: string[] }> }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <p className="text-sm font-semibold text-ink">Business values and who confirmed them</p>
      <p className="mt-1 text-2xs text-muted">
        A value nobody has confirmed is shown as undecided and blocks whatever depends on it. Nothing here is chosen for you.
      </p>
      <table className="mt-3 w-full text-xs">
        <thead className="text-muted">
          <tr><th className="text-left font-medium">Setting</th><th className="text-left font-medium">Current value</th><th className="text-left font-medium">Confirmed</th></tr>
        </thead>
        <tbody>
          {CONFIRMABLE.map((row) => {
            const c = confirmations[row.key];
            return (
              <tr key={row.key} className="border-t border-line">
                <td className="py-1 pr-2">{row.label}</td>
                <td className="py-1 pr-2 tabular">{row.read(settings)}</td>
                <td className="py-1 text-muted">{c ? `${c.by} · ${c.at.slice(0, 10)}${c.note ? ` · ${c.note}` : ''}` : 'Not confirmed by anyone'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {history.length > 0 ? (
        <p className="mt-2 text-2xs text-muted">
          Last change: {history[0]!.by} on {history[0]!.at.slice(0, 10)} ({history[0]!.changed.join(', ') || 'no field'}).
        </p>
      ) : null}
    </div>
  );
}

function SettingsForm({ s }: { s: AccountingSettingsResponse }) {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [draft, setDraft] = useState<Partial<AccountingSettings>>(s.settings);
  const [anchor, setAnchor] = useState<string>(s.dispatcherPeriodAnchor ?? '');
  const save = useMutation({
    mutationFn: () => saveSettings({ expectedVersion: s.version, settings: draft, dispatcherPeriodAnchor: anchor || null }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['accounting'] });
      toast({ tone: 'success', title: 'Settings saved' });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  const numOrNull = (v: string) => (v.trim() === '' ? null : Number(v));

  return (
    <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-4">
        {s.problems.length > 0 ? (
          <Alert tone="warning" title={`${s.problems.length} setting${s.problems.length === 1 ? '' : 's'} need configuration`} description={<ul className="mt-1 list-disc pl-4">{s.problems.map((p) => <li key={p.key}><b>{p.label}</b> — blocks: {p.blocks}</li>)}</ul>} />
        ) : <Alert tone="success" title="Every accounting setting is confirmed" />}
        <ConfirmedValues settings={s.settings} confirmations={s.confirmations ?? {}} history={s.history ?? []} />
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-sm font-semibold text-ink">Factoring (RTS)</p>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <FormField label="Fee, basis points of gross" description="The quote was contradictory (0.075% vs 0.75%): enter the verified figure. 75 = 0.75%."><Input type="number" min={0} value={draft.factoringFeeBps ?? ''} onChange={(e) => setDraft((d) => ({ ...d, factoringFeeBps: numOrNull(e.target.value) }))} disabled={!canEdit} aria-label="Factoring fee bps" /></FormField>
            <FormField label="Reserve / holdback, basis points" description="0 when RTS keeps no reserve."><Input type="number" min={0} value={draft.factoringReserveBps ?? ''} onChange={(e) => setDraft((d) => ({ ...d, factoringReserveBps: numOrNull(e.target.value) }))} disabled={!canEdit} aria-label="Reserve bps" /></FormField>
            <FormField label="Default payment terms (days)"><Input type="number" min={0} value={draft.defaultPaymentTermsDays ?? 30} onChange={(e) => setDraft((d) => ({ ...d, defaultPaymentTermsDays: Number(e.target.value) || 0 }))} disabled={!canEdit} aria-label="Payment terms" /></FormField>
            <FormField label="QuickBooks owns postings?" description="Decides whether this ledger is authoritative."><Select options={[{ value: '', label: 'Not decided' }, { value: 'yes', label: 'Yes, QuickBooks' }, { value: 'no', label: 'No, this ledger' }]} value={draft.quickbooksOwnsPostings === null || draft.quickbooksOwnsPostings === undefined ? '' : draft.quickbooksOwnsPostings ? 'yes' : 'no'} onValueChange={(v) => setDraft((d) => ({ ...d, quickbooksOwnsPostings: v === '' ? null : v === 'yes' }))} disabled={!canEdit} /></FormField>
          </div>
          <div className="mt-3">
            <p className="text-xs font-semibold text-secondary">Holiday fees</p>
            {(draft.holidayFees ?? []).map((f, i) => (
              <div key={i} className="mt-2 grid grid-cols-[minmax(0,1fr)_120px_180px] gap-2">
                <Input value={f.label} onChange={(e) => setDraft((d) => ({ ...d, holidayFees: (d.holidayFees ?? []).map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) }))} disabled={!canEdit} aria-label="Fee label" />
                <Input prefix="$" type="number" value={f.amountCents / 100} onChange={(e) => setDraft((d) => ({ ...d, holidayFees: (d.holidayFees ?? []).map((x, j) => (j === i ? { ...x, amountCents: Math.round(Number(e.target.value) * 100) } : x)) }))} disabled={!canEdit} aria-label="Fee amount" />
                <Select options={[{ value: '', label: 'Scope: not decided' }, { value: 'per_batch', label: 'Per batch' }, { value: 'per_payment', label: 'Per payment' }, { value: 'per_load', label: 'Per load' }]} value={f.scope ?? ''} onValueChange={(v) => setDraft((d) => ({ ...d, holidayFees: (d.holidayFees ?? []).map((x, j) => (j === i ? { ...x, scope: (v || null) as 'per_batch' | 'per_payment' | 'per_load' | null } : x)) }))} disabled={!canEdit} />
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-sm font-semibold text-ink">Settlements</p>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <FormField label="Pay week starts and ends (Monday, US Eastern)" description="A load completed before this time on Monday is paid in the week that is ending; at this time or later, in the new week. 12:00 = noon."><Input type="time" value={draft.payPeriodCutoffTime ?? '12:00'} onChange={(e) => setDraft((d) => ({ ...d, payPeriodCutoffTime: e.target.value }))} disabled={!canEdit} aria-label="Pay week cutoff time" /></FormField>
            <FormField label="Cutoff reads" description="Which timestamp decides the week. Unconfirmed: batches wait."><Select options={[{ value: '', label: 'Not decided' }, { value: 'delivered_at', label: 'Actual delivery time' }, { value: 'status_updated_at', label: 'Status update time' }]} value={draft.cutoffBasis ?? ''} onValueChange={(v) => setDraft((d) => ({ ...d, cutoffBasis: (v || null) as 'delivered_at' | 'status_updated_at' | null }))} disabled={!canEdit} /></FormField>
            <div className="md:col-span-2 flex items-center gap-2"><Checkbox checked={draft.cutoffTimezoneConfirmed === true} onCheckedChange={(v) => setDraft((d) => ({ ...d, cutoffTimezoneConfirmed: v === true ? true : null }))} disabled={!canEdit} label={`I confirm the settlement cutoff clock is US Eastern (${s.timezone.value})`} /></div>
            <FormField label="Payday"><Select options={['monday', 'tuesday', 'wednesday', 'thursday', 'friday'].map((d) => ({ value: d, label: d[0]!.toUpperCase() + d.slice(1) }))} value={draft.payDay ?? 'thursday'} onValueChange={(v) => setDraft((d) => ({ ...d, payDay: v as AccountingSettings['payDay'] }))} disabled={!canEdit} /></FormField>
            <FormField label="LO/OO paid only after funding?"><Select options={[{ value: '', label: 'Not decided' }, { value: 'yes', label: 'Yes' }, { value: 'no', label: 'No' }]} value={draft.payOnFundingOnly === null || draft.payOnFundingOnly === undefined ? '' : draft.payOnFundingOnly ? 'yes' : 'no'} onValueChange={(v) => setDraft((d) => ({ ...d, payOnFundingOnly: v === '' ? null : v === 'yes' }))} disabled={!canEdit} /></FormField>
            <FormField label="Team base-mileage split" description="The 50/50 rule for extras does not decide this."><Select options={[{ value: '', label: 'Not decided' }, { value: 'each_full', label: 'Each driver full miles' }, { value: 'split_50_50', label: 'Split 50/50' }]} value={draft.teamBaseMileageSplit ?? ''} onValueChange={(v) => setDraft((d) => ({ ...d, teamBaseMileageSplit: (v || null) as 'each_full' | 'split_50_50' | null }))} disabled={!canEdit} /></FormField>
            <FormField label="Vendor default share, basis points" description="Blank = every arrangement must say its own."><Input type="number" min={0} value={draft.vendorDefaultPercentBps ?? ''} onChange={(e) => setDraft((d) => ({ ...d, vendorDefaultPercentBps: numOrNull(e.target.value) }))} disabled={!canEdit} aria-label="Vendor share bps" /></FormField>
            <FormField label="Escrow target ($)"><Input prefix="$" type="number" value={(draft.escrowTargetCents ?? 250_000) / 100} onChange={(e) => setDraft((d) => ({ ...d, escrowTargetCents: Math.round(Number(e.target.value) * 100) }))} disabled={!canEdit} aria-label="Escrow target" /></FormField>
            <FormField label="Escrow per settlement ($)"><Input prefix="$" type="number" value={(draft.escrowPerSettlementCents ?? 35_000) / 100} onChange={(e) => setDraft((d) => ({ ...d, escrowPerSettlementCents: Math.round(Number(e.target.value) * 100) }))} disabled={!canEdit} aria-label="Escrow per settlement" /></FormField>
          </div>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <p className="text-sm font-semibold text-ink">Staff payroll</p>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <FormField label="Dispatcher four-week period anchor (a Monday)" description="Periods run 28 days from here, never calendar months."><Input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} disabled={!canEdit} aria-label="Anchor Monday" /></FormField>
            <FormField label="Payroll currency"><Input value={draft.payrollCurrency ?? 'USD'} onChange={(e) => setDraft((d) => ({ ...d, payrollCurrency: e.target.value.toUpperCase().slice(0, 3) }))} disabled={!canEdit} aria-label="Currency" /></FormField>
          </div>
          <p className="mt-2 text-xs text-muted">The dispatcher commission formula is the dispatch policy in force (Dispatch › Commission). Until Sean’s figures arrive, a commission line is entered as an approved amount with its reason.</p>
        </div>
        {canEdit ? <div><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save settings</Button></div> : null}
      </div>
      <div className="rounded-xl border border-line bg-surface p-4">
        <p className="text-sm font-semibold text-ink">Providers</p>
        <p className="mt-1 text-xs text-muted">What is actually connected on this server. A flag or a button never means a live integration.</p>
        <ul className="mt-3 divide-y divide-line-soft">
          {Object.entries(s.integrations).map(([k, v]) => (
            <li key={k} className="flex items-start justify-between gap-3 py-2 text-sm"><span><span className="text-ink">{INTEGRATION_LABEL[k] ?? k}</span><span className="block text-xs text-muted">{v.detail}</span></span><Badge tone={STATUS_LABEL[v.state]?.tone ?? 'neutral'} size="sm">{STATUS_LABEL[v.state]?.label ?? v.state}</Badge></li>
          ))}
        </ul>
        <p className="mt-3 text-2xs text-muted">Live means credentials are on file and a real exchange was verified. Sandbox means tested against a stand-in. Export means a file this system produces, in a format the receiver has not certified. CSV import means a file somebody exports from the provider portal.</p>
        <p className="mt-3 text-xs text-secondary"><span className="font-semibold text-ink">Cutoff clock:</span> {s.timezone.value} ({s.timezone.source}). {s.settings.cutoffTimezoneConfirmed === true ? <Badge tone="success" size="sm">Confirmed</Badge> : <><span>{s.timezone.note}</span> <Badge tone="warning" size="sm">Needs confirmation</Badge></>}</p>
      </div>
    </div>
  );
}
