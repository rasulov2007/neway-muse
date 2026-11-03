import { BarChart3, Coins, FileText, History, Megaphone, Plus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  CAMPAIGN_CHANNELS,
  CAMPAIGN_CHANNEL_LABELS,
  easternDay,
  type Campaign,
  type CampaignSpendEntry,
  type CreateCampaignInput,
  type CreateCampaignSpendInput,
} from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  DataTable,
  DatePicker,
  FormField,
  Input,
  MenuItem,
  Modal,
  Select,
  Textarea,
  createColumns,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { Panel, PanelEmpty, StatCard } from './RecruitingKit';
import { fieldErrors, money, moneyOrDash, newClientKey } from './recruiting-kit';
import { hiringApi, useCampaignSpend, useCampaigns, useHiringMutation } from './useHiring';

const col = createColumns<Campaign>();

/**
 * Recruiting › Campaigns (owner's redesign, 2026-10-01).
 *
 * A campaign is where leads come from and what was spent to get them. Spend is entered by date
 * (owner, 2026-10-01): each payment is its own entry with a date, amount, note and who entered
 * it, kept in the campaign's spend history and voided — never deleted — when it is wrong. The
 * figures here are the server's and campaign-to-date: every live entry plus the campaign's own
 * cost entries such as per-lead fees. Analytics takes the entries dated in its period. A figure
 * with nothing to divide by is a dash, never $0.
 */
export function CampaignsTab({ onOpenTab }: { onOpenTab: (tab: string, extra?: Record<string, unknown>) => void }) {
  const campaigns = useCampaigns();
  const canManage = useAccount()?.permissions.includes('recruiting.manage') ?? false;
  const [editing, setEditing] = useState<Campaign | 'new' | null>(null);
  const [spendOf, setSpendOf] = useState<Campaign | null>(null);
  const today = companyToday();

  const rows = campaigns.data ?? [];
  const loaded = campaigns.data !== undefined;
  const active = rows.filter((c) => c.active).length;
  const totalCost = rows.reduce((s, c) => s + c.totalCost, 0);
  const leads = rows.reduce((s, c) => s + c.leadCount, 0);

  const viewLeads = (c: Campaign) => {
    const created = easternDay(c.createdAt);
    onOpenTab('leads', { campaign: c.id, from: c.periodStart < created ? c.periodStart : created, to: today });
  };

  const columns = useMemo(
    () => [
      col.accessor('name', {
        header: 'Campaign',
        meta: { primary: true, width: 240 },
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col">
            <span className="truncate font-semibold text-ink" title={row.original.name}>
              {row.original.name}
            </span>
            <span className="truncate text-xs text-muted">{row.original.ownerName ?? 'No owner'}</span>
          </span>
        ),
      }),
      col.accessor('channel', { header: 'Channel', meta: { width: 130 }, cell: (info) => CAMPAIGN_CHANNEL_LABELS[info.getValue()] }),
      col.accessor('periodStart', {
        header: 'Dates',
        meta: { width: 190 },
        cell: ({ row }) =>
          `${formatIsoDate(row.original.periodStart)} – ${row.original.periodEnd ? formatIsoDate(row.original.periodEnd) : 'open'}`,
      }),
      col.accessor('active', {
        header: 'Status',
        meta: { width: 100 },
        cell: (info) => (
          <Badge tone={info.getValue() ? 'success' : 'neutral'} dot>
            {info.getValue() ? 'Active' : 'Ended'}
          </Badge>
        ),
      }),
      col.accessor('totalCost', {
        header: 'Spend',
        meta: { align: 'right', width: 110 },
        cell: ({ row }) => (
          <span className="flex flex-col items-end">
            <span
              title={`Dated spend ${money(row.original.spend)} + campaign cost entries ${money(row.original.acquisitionCost)}`}
            >
              {money(row.original.totalCost)}
            </span>
            <span className="text-2xs text-muted">
              {row.original.spendEntryCount === 0
                ? 'No spend entries'
                : `${row.original.spendEntryCount} entr${row.original.spendEntryCount === 1 ? 'y' : 'ies'}`}
            </span>
          </span>
        ),
      }),
      col.accessor('leadCount', { header: 'Leads', meta: { align: 'right', width: 80 } }),
      col.accessor('candidateCount', {
        header: 'Candidates',
        meta: { align: 'right', width: 100 },
      }),
      col.accessor('hireCount', { header: 'Hires', meta: { align: 'right', width: 70 } }),
      col.accessor('costPerLead', {
        header: 'Cost / lead',
        meta: { align: 'right', width: 110 },
        cell: (info) => <span title={info.getValue() === null ? 'No leads attributed yet' : undefined}>{moneyOrDash(info.getValue())}</span>,
      }),
      col.accessor('costPerHire', {
        header: 'Cost / hire',
        meta: { align: 'right', width: 110 },
        cell: (info) => <span title={info.getValue() === null ? 'No hires from this campaign yet' : undefined}>{moneyOrDash(info.getValue())}</span>,
      }),
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4" data-testid="campaigns-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink">Campaigns</h2>
          <p className="text-sm text-muted">
            Where leads come from and what it cost to find them — campaign to date. Spend is entered by date in each campaign's spend history.
          </p>
        </div>
        {canManage && rows.length > 0 ? (
          <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
            Add campaign
          </Button>
        ) : null}
      </div>

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Campaign figures">
        <StatCard icon={<Megaphone />} label="Active campaigns" value={loaded ? active : null} hint={loaded ? `${rows.length} in all` : undefined} />
        <StatCard
          icon={<Coins />}
          tone="info"
          label="Total spend"
          value={loaded ? money(totalCost) : null}
          hint="Dated spend plus campaign fees, to date"
        />
        <StatCard icon={<Users />} label="Attributed leads" value={loaded ? leads : null} hint="Leads tied to a campaign" />
        <StatCard
          icon={<BarChart3 />}
          tone="violet"
          label="Cost per lead"
          value={loaded ? (leads > 0 ? money(totalCost / leads) : '—') : null}
          hint={loaded ? (leads > 0 ? 'Total spend over attributed leads' : 'No attributed leads yet') : undefined}
        />
      </section>

      {campaigns.error ? (
        <Alert tone="danger" title="Campaigns could not be loaded" description={campaigns.error instanceof Error ? campaigns.error.message : undefined} />
      ) : !loaded ? (
        <Panel>
          <p className="text-sm text-muted">Loading…</p>
        </Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <PanelEmpty
            icon={<Megaphone />}
            title="Start your first recruiting campaign"
            description="Track where leads come from and what each hire costs."
            action={
              canManage ? (
                <Button variant="primary" icon={<Plus />} onClick={() => setEditing('new')}>
                  Create campaign
                </Button>
              ) : (
                <span className="text-xs text-muted">Creating a campaign takes the recruiting manage permission.</span>
              )
            }
          />
          <ol className="grid gap-4 border-t border-nw-border pt-4 md:grid-cols-3">
            {[
              { icon: <FileText />, title: 'Set up a campaign', text: 'Give it a name, the channel and the dates; add each payment by date.' },
              { icon: <Users />, title: 'Attribute leads', text: 'Pick the campaign when you add a lead it brought in.' },
              { icon: <BarChart3 />, title: 'Measure results', text: 'See leads, candidates, hires and cost per lead here and in Analytics.' },
            ].map((step, i) => (
              <li key={step.title} className="flex gap-3">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-bold text-primary-text">
                  {i + 1}
                </span>
                <span>
                  <span className="block text-sm font-semibold text-ink">{step.title}</span>
                  <span className="block text-xs text-muted">{step.text}</span>
                </span>
              </li>
            ))}
          </ol>
        </Panel>
      ) : (
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(c) => c.id}
          caption="Campaigns"
          loading={campaigns.isPending}
          onRowClick={canManage ? (c) => setEditing(c) : undefined}
          rowActions={(c) => (
            <>
              <MenuItem onSelect={() => setSpendOf(c)}>Spend history</MenuItem>
              <MenuItem onSelect={() => viewLeads(c)}>View attributed leads</MenuItem>
              {canManage ? <MenuItem onSelect={() => setEditing(c)}>Edit campaign</MenuItem> : null}
            </>
          )}
        />
      )}

      {editing ? (
        <CampaignModal
          campaign={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onOpenSpend={(c) => {
            setEditing(null);
            setSpendOf(c);
          }}
        />
      ) : null}
      {spendOf ? <SpendHistoryModal campaign={rows.find((c) => c.id === spendOf.id) ?? spendOf} canManage={canManage} onClose={() => setSpendOf(null)} /> : null}
    </div>
  );
}

function CampaignModal({
  campaign,
  onClose,
  onOpenSpend,
}: {
  campaign: Campaign | null;
  onClose: () => void;
  onOpenSpend: (campaign: Campaign) => void;
}) {
  const { toast } = useToast();
  const employees = useEmployeeDirectory();
  const create = useHiringMutation((body: CreateCampaignInput) => hiringApi.createCampaign(body));
  const update = useHiringMutation((body: Partial<CreateCampaignInput>) => hiringApi.updateCampaign(campaign?.id ?? '', body));
  const [form, setForm] = useState({
    name: campaign?.name ?? '',
    channel: campaign?.channel ?? 'job_board',
    periodStart: campaign?.periodStart ?? companyToday(),
    periodEnd: campaign?.periodEnd ?? '',
    spend: '',
    ownerEmployeeId: campaign?.ownerEmployeeId ?? '',
    notes: campaign?.notes ?? '',
    active: campaign?.active ?? true,
  });
  const [tried, setTried] = useState(false);
  const set = (k: string, v: string | boolean) => setForm((p) => ({ ...p, [k]: v }));
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const server = fieldErrors(error);
  const spend = form.spend.trim() === '' ? 0 : Number(form.spend);
  const local: Record<string, string | null> = {
    name: form.name.trim() ? null : 'Give the campaign a name',
    periodStart: form.periodStart ? null : 'Choose the start date',
    periodEnd: form.periodEnd && form.periodStart && form.periodEnd < form.periodStart ? 'The end date is before the start date' : null,
    spend: campaign || (Number.isFinite(spend) && spend >= 0) ? null : 'Enter an amount of $0 or more',
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;
  const submit = () => {
    setTried(true);
    if (Object.values(local).some((v) => v !== null)) return;
    const fields = {
      name: form.name.trim(),
      channel: form.channel as (typeof CAMPAIGN_CHANNELS)[number],
      periodStart: form.periodStart,
      periodEnd: form.periodEnd || null,
      ownerEmployeeId: form.ownerEmployeeId || null,
      notes: form.notes || null,
      active: form.active,
    };
    const done = () => {
      toast({ tone: 'success', title: campaign ? 'Campaign saved' : 'Campaign added' });
      onClose();
    };
    // Spend is not edited here once the campaign exists: it is the dated entries.
    if (campaign) update.mutate(fields, { onSuccess: done });
    else create.mutate({ ...fields, spend }, { onSuccess: done });
  };
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={campaign ? `Edit ${campaign.name}` : 'Add campaign'}
      description={
        campaign
          ? 'Spend is entered by date in the spend history. Leads are attributed when they are added.'
          : 'Anything already spent is recorded as the first spend entry, dated on the start date. Leads are attributed when they are added.'
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={pending} onClick={submit}>
            {campaign ? 'Save' : 'Add campaign'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-testid="campaign-form">
        {error && Object.keys(server).length === 0 ? (
          <div className="sm:col-span-2">
            <Alert tone="danger" title="Not saved" description={error instanceof ApiError ? error.message : 'Failed.'} />
          </div>
        ) : null}
        <div className="sm:col-span-2">
          <FormField label="Name" required error={err('name')}>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </FormField>
        </div>
        <FormField label="Channel" error={err('channel')}>
          <Select
            aria-label="Channel"
            value={form.channel}
            onValueChange={(v) => set('channel', v)}
            options={CAMPAIGN_CHANNELS.map((c) => ({ value: c, label: CAMPAIGN_CHANNEL_LABELS[c] }))}
          />
        </FormField>
        {campaign ? (
          <FormField label="Spend to date" description={`${campaign.spendEntryCount} dated entr${campaign.spendEntryCount === 1 ? 'y' : 'ies'}`}>
            <div className="flex min-h-9 items-center gap-2">
              <span className="tabular font-semibold text-ink">{money(campaign.spend)}</span>
              <Button size="sm" variant="outline" icon={<History />} onClick={() => onOpenSpend(campaign)}>
                Spend history
              </Button>
            </div>
          </FormField>
        ) : (
          <FormField label="Spent so far ($)" error={err('spend')} description="Optional. Dated on the start date.">
            <Input type="number" min="0" step="0.01" value={form.spend} onChange={(e) => set('spend', e.target.value)} />
          </FormField>
        )}
        <FormField label="Start date" required error={err('periodStart')}>
          <DatePicker aria-label="Start date" value={form.periodStart} onIsoChange={(e) => set('periodStart', e)} />
        </FormField>
        <FormField label="End date" error={err('periodEnd')} description="Blank while it is still running.">
          <DatePicker aria-label="End date" value={form.periodEnd} onIsoChange={(e) => set('periodEnd', e)} />
        </FormField>
        <FormField label="Owner" error={err('ownerEmployeeId')}>
          <Select
            aria-label="Owner"
            value={form.ownerEmployeeId}
            onValueChange={(v) => set('ownerEmployeeId', v)}
            options={[
              { value: '', label: 'Nobody' },
              ...(employees.data ?? [])
                .filter((e) => e.status !== 'terminated' || e.id === form.ownerEmployeeId)
                .map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` })),
            ]}
          />
        </FormField>
        <div className="flex items-end pb-2">
          <Checkbox label="Active — offered when adding a lead" checked={form.active} onCheckedChange={(v) => set('active', v === true)} />
        </div>
        <div className="sm:col-span-2">
          <FormField label="Notes">
            <Textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

/**
 * One campaign's spend, by date: add a payment, correct one (the save names the version it read,
 * so a stale edit is refused rather than overwriting), or void one with a reason. Voided entries
 * stay in the list, struck through, and count for nothing.
 */
function SpendHistoryModal({ campaign, canManage, onClose }: { campaign: Campaign; canManage: boolean; onClose: () => void }) {
  const { toast } = useToast();
  const spend = useCampaignSpend(campaign.id);
  const [editing, setEditing] = useState<CampaignSpendEntry | null>(null);
  const [voiding, setVoiding] = useState<CampaignSpendEntry | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [clientKey, setClientKey] = useState(newClientKey);
  const blank = { spentOn: companyToday(), amount: '', note: '' };
  const [form, setForm] = useState(blank);
  const [tried, setTried] = useState(false);
  const add = useHiringMutation((body: CreateCampaignSpendInput) => hiringApi.addCampaignSpend(campaign.id, body));
  const save = useHiringMutation((e: CampaignSpendEntry) =>
    hiringApi.updateCampaignSpend(e.id, { version: e.version, spentOn: form.spentOn, amount: Number(form.amount), note: form.note.trim() || null }),
  );
  const voidIt = useHiringMutation((e: CampaignSpendEntry) => hiringApi.voidCampaignSpend(e.id, { version: e.version, reason: voidReason.trim() }));
  const amount = Number(form.amount);
  const local: Record<string, string | null> = {
    spentOn: form.spentOn ? null : 'Choose the date',
    amount: form.amount.trim() && Number.isFinite(amount) && amount > 0 ? null : 'Enter an amount above $0',
  };
  const error = add.error ?? save.error;
  const server = fieldErrors(error);
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;
  const rows = spend.data ?? [];
  const live = rows.filter((r) => !r.voidedAt);
  const reset = () => {
    setForm({ spentOn: companyToday(), amount: '', note: '' });
    setEditing(null);
    setTried(false);
    setClientKey(newClientKey());
    add.reset();
    save.reset();
  };
  const submit = () => {
    setTried(true);
    if (Object.values(local).some((v) => v !== null)) return;
    if (editing) {
      save.mutate(editing, {
        onSuccess: () => {
          toast({ tone: 'success', title: 'Spend entry corrected' });
          reset();
        },
      });
    } else {
      add.mutate(
        { spentOn: form.spentOn, amount, note: form.note.trim() || null, clientKey },
        {
          onSuccess: () => {
            toast({ tone: 'success', title: 'Spend added' });
            reset();
          },
        },
      );
    }
  };
  return (
    <Modal
      open
      size="lg"
      onOpenChange={(o) => !o && onClose()}
      title={`Spend history · ${campaign.name}`}
      description="Each payment on its own date, so a reporting period takes only what was spent inside it. Wrong entries are voided, not deleted."
    >
      <div className="flex flex-col gap-4" data-testid="spend-history">
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          <div className="rounded-[10px] border border-nw-border bg-nw-subtle px-3 py-2">
            <dt className="text-2xs font-semibold text-muted">Spend to date</dt>
            <dd className="tabular text-lg font-bold text-ink">{spend.data ? money(live.reduce((s, r) => s + r.amount, 0)) : 'Loading…'}</dd>
          </div>
          <div className="rounded-[10px] border border-nw-border bg-nw-subtle px-3 py-2">
            <dt className="text-2xs font-semibold text-muted">Entries</dt>
            <dd className="tabular text-lg font-bold text-ink">{spend.data ? live.length : 'Loading…'}</dd>
          </div>
          <div className="rounded-[10px] border border-nw-border bg-nw-subtle px-3 py-2">
            <dt className="text-2xs font-semibold text-muted">Campaign fees (cost entries)</dt>
            <dd className="tabular text-lg font-bold text-ink">{money(campaign.acquisitionCost)}</dd>
          </div>
        </dl>

        {canManage ? (
          <section className="rounded-[10px] border border-nw-border p-3" aria-label={editing ? 'Correct spend entry' : 'Add spend'}>
            <h3 className="mb-2 text-sm font-bold text-ink">{editing ? `Correct the entry of ${formatIsoDate(editing.spentOn)}` : 'Add spend'}</h3>
            {error && Object.keys(server).length === 0 ? (
              <div className="mb-2">
                <Alert tone="danger" title="Not saved" description={error instanceof ApiError ? error.message : 'Failed.'} />
              </div>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-[10rem_9rem_minmax(0,1fr)]">
              <FormField label="Date" required error={err('spentOn')}>
                <DatePicker aria-label="Spend date" value={form.spentOn} onIsoChange={(v) => setForm((p) => ({ ...p, spentOn: v }))} />
              </FormField>
              <FormField label="Amount ($)" required error={err('amount')}>
                <Input prefix="$" aria-label="Spend amount" type="number" min="0" step="0.01" value={form.amount} onChange={(e) => setForm((p) => ({ ...p, amount: e.target.value }))} />
              </FormField>
              <FormField label="Note" error={err('note')}>
                <Input aria-label="Spend note" value={form.note} placeholder="Invoice, month, what it bought…" onChange={(e) => setForm((p) => ({ ...p, note: e.target.value }))} />
              </FormField>
            </div>
            <div className="mt-2 flex justify-end gap-2">
              {editing ? (
                <Button variant="ghost" size="sm" onClick={reset}>
                  Cancel
                </Button>
              ) : null}
              <Button variant="primary" size="sm" icon={editing ? undefined : <Plus />} loading={add.isPending || save.isPending} onClick={submit}>
                {editing ? 'Save correction' : 'Add spend'}
              </Button>
            </div>
          </section>
        ) : null}

        {spend.error ? (
          <Alert tone="danger" title="Spend could not be loaded" description={spend.error instanceof Error ? spend.error.message : undefined} />
        ) : !spend.data ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted">No spend entered yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead>
                <tr className="border-y border-nw-border bg-nw-subtle text-xs font-semibold text-nw-text-2">
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Note</th>
                  <th className="px-3 py-2 text-left">Entered by</th>
                  <th className="px-3 py-2 text-right">Amount</th>
                  <th className="w-40 px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nw-border">
                {rows.map((r) => (
                  <tr key={r.id} className={r.voidedAt ? 'text-faint' : undefined} data-testid="spend-row">
                    <td className="px-3 py-2 whitespace-nowrap">{formatIsoDate(r.spentOn)}</td>
                    <td className="px-3 py-2">
                      <span className={r.voidedAt ? 'line-through' : 'text-ink'}>{r.note ?? '—'}</span>
                      {r.voidedAt ? (
                        <span className="block text-xs text-muted">
                          Voided {formatIsoDate(easternDay(r.voidedAt))} by {r.voidedBy}: {r.voidReason}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 text-secondary">{r.recordedBy}</td>
                    <td className={`tabular px-3 py-2 text-right font-semibold ${r.voidedAt ? 'line-through' : 'text-ink'}`}>{money(r.amount)}</td>
                    <td className="px-3 py-2 text-right">
                      {r.voidedAt ? (
                        <Badge tone="neutral" dot>
                          Voided
                        </Badge>
                      ) : canManage ? (
                        voiding?.id === r.id ? (
                          <span className="flex flex-col items-end gap-1">
                            <Input aria-label="Reason for voiding" placeholder="Why?" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} />
                            <span className="flex gap-1">
                              <Button size="sm" variant="ghost" onClick={() => setVoiding(null)}>
                                Keep
                              </Button>
                              <Button
                                size="sm"
                                variant="danger"
                                disabled={!voidReason.trim()}
                                loading={voidIt.isPending}
                                onClick={() =>
                                  voidIt.mutate(r, {
                                    onSuccess: () => {
                                      toast({ tone: 'success', title: 'Spend entry voided' });
                                      setVoiding(null);
                                      setVoidReason('');
                                    },
                                  })
                                }
                              >
                                Void
                              </Button>
                            </span>
                            {voidIt.error ? <span className="text-2xs text-danger-text">{voidIt.error instanceof ApiError ? voidIt.error.message : 'Failed.'}</span> : null}
                          </span>
                        ) : (
                          <span className="flex justify-end gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => {
                                setEditing(r);
                                setForm({ spentOn: r.spentOn, amount: String(r.amount), note: r.note ?? '' });
                              }}
                            >
                              Edit
                            </Button>
                            <Button size="sm" variant="ghost" onClick={() => { setVoiding(r); setVoidReason(''); voidIt.reset(); }}>
                              Void
                            </Button>
                          </span>
                        )
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
