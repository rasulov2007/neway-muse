import { Link } from '@tanstack/react-router';
import {
  CircleDollarSign,
  ClipboardList,
  ExternalLink,
  FileText,
  Gift,
  Info,
  MoreHorizontal,
  Paperclip,
  Plane,
  Plus,
  Receipt,
  Settings2,
  ShieldCheck,
  Upload,
} from 'lucide-react';
import { useMemo, useRef, useState, type ReactNode } from 'react';
import {
  COST_CATEGORIES,
  COST_CATEGORY_LABELS,
  COST_CATEGORY_OF_TYPE,
  COST_TYPES,
  COST_TYPE_LABELS,
  ACCOUNTING_POST_PERMISSION,
  type CostAccountingState,
  type CostCategory,
  type CostEntry,
  type CostType,
  type HiringCase,
} from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  DatePicker,
  DropdownMenu,
  FormField,
  IconButton,
  Input,
  MenuItem,
  Modal,
  Select,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { ReceiptPreview } from '@/features/accounting/ReceiptPreview';
import { useAccount } from '@/features/auth/auth-context';
import { ApiError } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';
import { uploadFile } from '@/lib/files';
import { formatIsoDate } from '@/lib/format';
import { Panel, PanelEmpty, StatCard } from './RecruitingKit';
import { fieldErrors, money, newClientKey } from './recruiting-kit';
import { hiringApi, useAccountingExpenses, useCaseCosts, useHiringMutation } from './useHiring';

/**
 * Candidate › Costs (owner's redesign, 2026-10-01).
 *
 * The ledger for one candidate: everything charged to the case and to the lead it came from.
 * Automatic entries are priced by the server from the record they name (a screening report, the
 * travel, orientation pay, the offer's bonuses) and follow that record; manual entries are typed
 * by a person, carry an optional receipt, and are voided — never deleted — when they are wrong.
 * A cost already booked in Accounting is attributed from that expense instead of being typed a
 * second time, and the server lets one expense back only one candidate cost.
 *
 * Every other cost that is real money (all entered costs; travel, lodging, orientation pay and
 * bonuses) is posted to Accounting by the server as an expense under Recruiting, when the person
 * saving it may post there (`accounting.edit`). Otherwise it is saved and shows "Not posted",
 * with a Post button for someone who may. Each row says where it stands, in a symbol and a word.
 * Nothing here pays anyone or moves money.
 */

const ACCOUNTING_TONE: Record<CostAccountingState, 'success' | 'info' | 'warning' | 'neutral'> = {
  posted: 'success',
  attributed: 'info',
  not_posted: 'warning',
  needs_update: 'warning',
  needs_void: 'warning',
  voided: 'neutral',
  not_applicable: 'neutral',
};
const ACCOUNTING_WORD: Record<CostAccountingState, string> = {
  posted: 'Posted',
  attributed: 'From Accounting',
  not_posted: 'Not posted',
  needs_update: 'Out of date',
  needs_void: 'Still in Accounting',
  voided: 'Expense voided',
  not_applicable: 'Estimate only',
};
const ACCOUNTING_ACTION: Partial<Record<CostAccountingState, string>> = {
  not_posted: 'Post to Accounting',
  needs_update: 'Update in Accounting',
  needs_void: 'Void in Accounting',
};

/** Where one cost stands in Accounting: symbol, word, the expense number, and the button. */
function AccountingCell({ entry, canPost }: { entry: CostEntry; canPost: boolean }) {
  const { toast } = useToast();
  const post = useHiringMutation(() => hiringApi.postCostToAccounting(entry.id));
  // `accounting` is absent only from an API older than this screen (a staggered deploy).
  const a = entry.accounting as CostEntry['accounting'] | undefined;
  // A voided cost that never reached Accounting has nothing to say here.
  if (!a || (a.state === 'voided' && !a.expenseNumber)) return <span className="text-xs text-faint">—</span>;
  const action = ACCOUNTING_ACTION[a.state];
  return (
    <div className="flex min-w-0 flex-col items-start gap-0.5" data-testid="cost-accounting" data-state={a.state}>
      <Badge tone={ACCOUNTING_TONE[a.state]} dot title={a.message ?? undefined}>
        {ACCOUNTING_WORD[a.state]}
      </Badge>
      {a.expenseNumber && a.state !== 'not_posted' ? (
        <span className="text-2xs text-muted">
          {a.expenseNumber}
          {a.expenseStatus === 'void' && a.state !== 'voided' ? ' (void)' : ''}
        </span>
      ) : null}
      {a.actionable && action ? (
        canPost ? (
          <>
            <Button
              size="sm"
              variant="outline"
              className="mt-0.5"
              loading={post.isPending}
              onClick={() =>
                post.mutate(undefined, {
                  onSuccess: (out) =>
                    toast({
                      tone: 'success',
                      title: out.accounting?.state === 'posted' ? `Posted as ${out.accounting?.expenseNumber}` : 'Accounting updated',
                    }),
                })
              }
            >
              {action}
            </Button>
            {post.error ? (
              <span className="max-w-[16rem] text-2xs text-danger-text">{post.error instanceof ApiError ? post.error.message : 'Failed.'}</span>
            ) : a.message && a.state !== 'not_posted' ? (
              <span className="max-w-[16rem] text-2xs text-muted">{a.message}</span>
            ) : null}
          </>
        ) : (
          <span className="max-w-[16rem] text-2xs text-muted">{a.message}</span>
        )
      ) : null}
    </div>
  );
}

const CATEGORY_ICON: Record<CostCategory, ReactNode> = {
  screening: <ShieldCheck />,
  travel: <Plane />,
  orientation: <ClipboardList />,
  bonuses: <Gift />,
  other: <MoreHorizontal />,
};

type SourceKind = 'auto' | 'manual' | 'accounting';
// "From Accounting" is a cost attributed from an expense Accounting already had; a cost that was
// posted to Accounting from here keeps its own source (entered or automatic).
const sourceKind = (e: CostEntry): SourceKind =>
  e.accounting?.state === 'attributed' || (e.accountingExpenseId && !e.accounting) ? 'accounting' : e.source === 'auto' ? 'auto' : 'manual';
const SOURCE_LABEL: Record<SourceKind, string> = { auto: 'Automatic', manual: 'Entered', accounting: 'From Accounting' };

function autoOrigin(ref: string | null): string {
  if (!ref) return 'its source record';
  if (ref.startsWith('doc:')) return 'a filed screening report';
  if (ref.startsWith('ticket:')) return 'the travel record';
  if (ref.startsWith('orientation:')) return 'the orientation record';
  if (ref.startsWith('offer:')) return 'the offer, at hire';
  return 'its source record';
}

export function CostsPanel({ hiringCase }: { hiringCase: HiringCase }) {
  const account = useAccount();
  const canManage = account?.permissions.includes('recruiting.manage') ?? false;
  const canSeeSettings = account?.permissions.includes('settings.view') ?? false;
  const canPost = account?.permissions.includes(ACCOUNTING_POST_PERMISSION) ?? false;
  const costs = useCaseCosts(hiringCase.id);
  const [adding, setAdding] = useState(false);
  const [voiding, setVoiding] = useState<CostEntry | null>(null);
  const [receipt, setReceipt] = useState<CostEntry | null>(null);
  const [category, setCategory] = useState<CostCategory | ''>('');
  const [source, setSource] = useState<SourceKind | ''>('');
  const [showVoided, setShowVoided] = useState(false);
  const [newestFirst, setNewestFirst] = useState(true);

  const entries = costs.data?.entries ?? [];
  const live = entries.filter((e) => !e.voidedAt);
  const voidedCount = entries.length - live.length;
  const outOfStep = entries.filter((e) => e.accounting?.actionable).length;
  const byCategory = useMemo(() => {
    const out = Object.fromEntries(COST_CATEGORIES.map((c) => [c, { total: 0, n: 0 }])) as Record<CostCategory, { total: number; n: number }>;
    for (const e of live) {
      const c = COST_CATEGORY_OF_TYPE[e.type];
      out[c].total += e.amount;
      out[c].n += 1;
    }
    return out;
  }, [live]);
  const visible = entries
    .filter((e) => showVoided || !e.voidedAt)
    .filter((e) => !category || COST_CATEGORY_OF_TYPE[e.type] === category)
    .filter((e) => !source || sourceKind(e) === source)
    .sort((a, b) => (newestFirst ? -1 : 1) * (a.incurredOn.localeCompare(b.incurredOn) || a.createdAt.localeCompare(b.createdAt)));

  return (
    <div className="flex flex-col gap-4" data-testid="candidate-costs">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink">Recruiting costs</h2>
          <p className="text-sm text-muted">What it cost to find, check, bring in and start this candidate.</p>
        </div>
        {canManage ? (
          <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
            Add cost
          </Button>
        ) : null}
      </div>

      <section className="grid gap-3 md:grid-cols-3" aria-label="Cost figures">
        <StatCard
          icon={<CircleDollarSign />}
          label="Total recorded"
          value={costs.data ? money(costs.data.summary.total) : null}
          hint="Voided entries are not counted"
          testId="case-cost-total"
        />
        <StatCard icon={<FileText />} tone="info" label="Cost entries" value={costs.data ? live.length : null} hint={voidedCount ? `${voidedCount} voided, kept on record` : undefined} />
        <StatCard
          icon={<Settings2 />}
          tone="violet"
          label="Automatically recorded"
          value={costs.data ? live.filter((e) => e.source === 'auto').length : null}
          hint="Priced from the record they name"
        />
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_20rem]">
        <Panel
          title="Cost history"
          bodyClassName="px-0 pb-0"
          actions={
            <>
              <Select
                aria-label="Category"
                className="w-full sm:w-44"
                value={category}
                onValueChange={(v) => setCategory(v as CostCategory | '')}
                options={[{ value: '', label: 'All categories' }, ...COST_CATEGORIES.map((c) => ({ value: c, label: COST_CATEGORY_LABELS[c] }))]}
              />
              <Select
                aria-label="Source"
                className="w-full sm:w-44"
                value={source}
                onValueChange={(v) => setSource(v as SourceKind | '')}
                options={[
                  { value: '', label: 'All sources' },
                  { value: 'auto', label: 'Automatic' },
                  { value: 'manual', label: 'Entered' },
                  { value: 'accounting', label: 'From Accounting' },
                ]}
              />
            </>
          }
        >
          {costs.error ? (
            <div className="px-4 pb-4">
              <Alert tone="danger" title="The costs could not be loaded" description={costs.error instanceof Error ? costs.error.message : undefined} />
            </div>
          ) : costs.isPending ? (
            <p className="px-4 pb-6 text-sm text-muted">Loading…</p>
          ) : visible.length === 0 ? (
            <PanelEmpty
              icon={<Receipt />}
              title={entries.length === 0 ? 'No costs recorded yet' : 'No costs match these filters'}
              description={
                entries.length === 0
                  ? 'Screening, travel, orientation and bonus costs appear here as they are recorded.'
                  : 'Choose another category or source.'
              }
              action={
                entries.length > 0 ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setCategory('');
                      setSource('');
                    }}
                  >
                    Clear filters
                  </Button>
                ) : undefined
              }
            />
          ) : (
            <div className="overflow-x-auto">
              {outOfStep > 0 ? (
                <div className="px-4 pb-3">
                  <Alert
                    tone="warning"
                    title={`${outOfStep} cost${outOfStep === 1 ? ' is' : 's are'} not in step with Accounting`}
                    description={
                      canPost
                        ? 'Use the button on each row to post it, update it or void it in Accounting.'
                        : `They are saved here. Someone with ${ACCOUNTING_POST_PERMISSION} (Accounting) needs to post them.`
                    }
                  />
                </div>
              ) : null}
              <table className="w-full min-w-[52rem] text-sm">
                <thead>
                  <tr className="border-y border-nw-border bg-nw-subtle text-xs font-semibold text-nw-text-2">
                    <th className="px-4 py-2 text-left">
                      <button type="button" className="inline-flex items-center gap-1 hover:text-nw-text" onClick={() => setNewestFirst((v) => !v)}>
                        Date <span aria-hidden>{newestFirst ? '↓' : '↑'}</span>
                        <span className="sr-only">{newestFirst ? 'newest first' : 'oldest first'}</span>
                      </button>
                    </th>
                    <th className="px-4 py-2 text-left">Category</th>
                    <th className="px-4 py-2 text-left">Description</th>
                    <th className="px-4 py-2 text-left">Source</th>
                    <th className="px-4 py-2 text-left">Accounting</th>
                    <th className="px-4 py-2 text-right">Amount</th>
                    <th className="w-10 px-2 py-2">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-nw-border">
                  {visible.map((e) => {
                    const kind = sourceKind(e);
                    return (
                      <tr key={e.id} className={cn(e.voidedAt && 'text-faint')} data-testid="cost-row">
                        <td className="px-4 py-2 whitespace-nowrap text-secondary">{formatIsoDate(e.incurredOn)}</td>
                        <td className="px-4 py-2">
                          <span className="block text-ink">{COST_CATEGORY_LABELS[COST_CATEGORY_OF_TYPE[e.type]]}</span>
                          <span className="block text-xs text-muted">{COST_TYPE_LABELS[e.type]}</span>
                        </td>
                        <td className="px-4 py-2">
                          <span className={cn('block', e.voidedAt && 'line-through')}>{e.note ?? <span className="text-faint">No description</span>}</span>
                          {e.voidedAt ? (
                            <span className="block text-xs text-muted">
                              Voided {formatIsoDate(e.voidedAt.slice(0, 10))} by {e.voidedBy}: {e.voidReason}
                            </span>
                          ) : null}
                          {e.receiptFileId ? (
                            <button
                              type="button"
                              className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-primary-text hover:underline"
                              onClick={() => setReceipt(e)}
                            >
                              <Paperclip aria-hidden className="size-3" /> Receipt
                            </button>
                          ) : null}
                        </td>
                        <td className="px-4 py-2">
                          <Badge
                            tone={e.voidedAt ? 'neutral' : kind === 'auto' ? 'info' : kind === 'accounting' ? 'success' : 'neutral'}
                            dot
                            title={kind === 'auto' ? `Priced from ${autoOrigin(e.sourceRef)}` : undefined}
                          >
                            {e.voidedAt ? 'Voided' : SOURCE_LABEL[kind]}
                          </Badge>
                          <span className="mt-0.5 block text-2xs text-muted">{kind === 'auto' ? `from ${autoOrigin(e.sourceRef)}` : `by ${e.recordedBy}`}</span>
                        </td>
                        <td className="px-4 py-2 align-top">
                          <AccountingCell entry={e} canPost={canPost} />
                        </td>
                        <td className={cn('tabular px-4 py-2 text-right font-semibold', e.voidedAt ? 'line-through' : 'text-ink')}>{money(e.amount)}</td>
                        <td className="px-2 py-2 text-right">
                          {canManage && kind !== 'auto' && !e.voidedAt ? (
                            <DropdownMenu
                              trigger={
                                <IconButton label={`Actions for the ${COST_TYPE_LABELS[e.type]} cost`} variant="ghost" size="sm">
                                  <MoreHorizontal />
                                </IconButton>
                              }
                            >
                              <MenuItem onSelect={() => setVoiding(e)}>
                                <span className="text-danger-text">Void entry…</span>
                              </MenuItem>
                            </DropdownMenu>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {voidedCount > 0 ? (
            <div className="border-t border-nw-border px-4 py-2">
              <Checkbox label={`Show ${voidedCount} voided entr${voidedCount === 1 ? 'y' : 'ies'}`} checked={showVoided} onCheckedChange={(v) => setShowVoided(v === true)} />
            </div>
          ) : null}
        </Panel>

        <div className="flex min-w-0 flex-col gap-4">
          <Panel title="Cost categories" bodyClassName="px-2 pb-2">
            <ul>
              {COST_CATEGORIES.map((c) => (
                <li key={c}>
                  <button
                    type="button"
                    aria-pressed={category === c}
                    onClick={() => setCategory(category === c ? '' : c)}
                    className={cn(
                      'flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left text-sm transition-colors duration-(--duration-fast)',
                      category === c ? 'bg-primary-soft' : 'hover:bg-nw-hover',
                    )}
                  >
                    <span aria-hidden className="flex size-8 shrink-0 items-center justify-center rounded-full bg-nw-subtle text-secondary [&_svg]:size-4">
                      {CATEGORY_ICON[c]}
                    </span>
                    <span className="flex-1 font-medium text-ink">{COST_CATEGORY_LABELS[c]}</span>
                    <span className="tabular text-xs text-muted">
                      {costs.data ? (byCategory[c].n === 0 ? 'No entries' : `${money(byCategory[c].total)} · ${byCategory[c].n}`) : 'Loading…'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Panel>
          <section className="flex gap-3 rounded-[10px] border border-nw-border bg-nw-panel p-4" aria-label="How costs are added">
            <Info aria-hidden className="mt-0.5 size-5 shrink-0 text-info-text" />
            <div className="min-w-0 text-xs text-secondary">
              <h3 className="mb-1 text-sm font-bold text-ink">How costs are added</h3>
              <ul className="list-disc space-y-1 pl-4">
                <li>Screening reports are priced from the unit costs in company settings when Safety files them — once each.</li>
                <li>Travel and lodging, orientation pay and the offer's bonuses are added from those records automatically.</li>
                <li>Anything else is added with Add cost. If it is already booked in Accounting, attribute that expense instead of typing it again.</li>
                <li>
                  Entered costs, travel, lodging, orientation pay and bonuses are posted to Accounting as expenses (category Recruiting) by
                  whoever saves them with {ACCOUNTING_POST_PERMISSION}; otherwise they wait, marked Not posted. Screening lines are estimates and are
                  not posted. Voiding a cost voids its expense too.
                </li>
              </ul>
              {canSeeSettings ? (
                <Link
                  to="/admin/settings"
                  className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary-text hover:underline"
                >
                  View cost settings <ExternalLink aria-hidden className="size-3.5" />
                </Link>
              ) : null}
            </div>
          </section>
        </div>
      </div>

      {adding ? <AddCostModal hiringCase={hiringCase} onClose={() => setAdding(false)} /> : null}
      {voiding ? <VoidCostModal entry={voiding} onClose={() => setVoiding(null)} /> : null}
      {receipt?.receiptFileId ? (
        <Modal open onOpenChange={(o) => !o && setReceipt(null)} title={`Receipt · ${COST_TYPE_LABELS[receipt.type]}`} size="lg">
          <div className="nw-paper">
            <ReceiptPreview fileId={receipt.receiptFileId} fileName={receipt.note ?? 'receipt'} />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function AddCostModal({ hiringCase, onClose }: { hiringCase: HiringCase; onClose: () => void }) {
  const { toast } = useToast();
  const permissions = useAccount()?.permissions ?? [];
  const canSeeAccounting = permissions.includes('accounting.view');
  const canPost = permissions.includes(ACCOUNTING_POST_PERMISSION);
  // One key per form: a double click or a resend after a timeout finds the first entry.
  const [clientKey] = useState(newClientKey);
  const [mode, setMode] = useState<'manual' | 'accounting'>('manual');
  const expenses = useAccountingExpenses(canSeeAccounting && mode === 'accounting');
  const create = useHiringMutation((body: Parameters<typeof hiringApi.createCost>[0]) => hiringApi.createCost(body));
  const [form, setForm] = useState({ type: '', amount: '', incurredOn: companyToday(), note: '', expenseId: '' });
  const [file, setFile] = useState<File | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const server = fieldErrors(create.error);
  const amount = Number(form.amount);
  const expense = (expenses.data ?? []).find((e) => e.id === form.expenseId) ?? null;
  const local: Record<string, string | null> = {
    type: form.type ? null : 'Choose what the cost was for',
    amount: mode === 'accounting' || (form.amount.trim() && Number.isFinite(amount) && amount > 0) ? null : 'Enter an amount above $0',
    incurredOn: mode === 'accounting' || form.incurredOn ? null : 'Choose the date',
    accountingExpenseId: mode === 'manual' || form.expenseId ? null : 'Choose the expense',
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;

  const save = async () => {
    setTried(true);
    if (Object.values(local).some((v) => v !== null)) return;
    let fileId = receiptId;
    if (mode === 'manual' && file && !fileId) {
      setUploading(true);
      setUploadError(null);
      try {
        fileId = (await uploadFile(file)).id;
        setReceiptId(fileId);
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : 'The receipt could not be uploaded');
        setUploading(false);
        return;
      }
      setUploading(false);
    }
    create.mutate(
      {
        hiringCaseId: hiringCase.id,
        leadId: null,
        campaignId: null,
        type: form.type as CostType,
        amount: mode === 'accounting' ? (expense?.amount ?? 0) : amount,
        incurredOn: mode === 'accounting' ? (expense?.onDate ?? form.incurredOn) : form.incurredOn,
        note: form.note.trim() || null,
        clientKey,
        receiptFileId: mode === 'manual' ? fileId : null,
        accountingExpenseId: mode === 'accounting' ? form.expenseId : null,
      },
      {
        onSuccess: (out) => {
          toast({
            tone: 'success',
            title:
              mode === 'accounting'
                ? 'Accounting expense attributed'
                : out.accounting?.state === 'posted'
                  ? `Cost recorded and posted as ${out.accounting?.expenseNumber}`
                  : 'Cost recorded — not posted to Accounting yet',
          });
          onClose();
        },
      },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Add cost"
      description={
        mode === 'accounting'
          ? `Charged to ${hiringCase.candidateName}. The expense is already in Accounting, so nothing new is posted.`
          : canPost
            ? `Charged to ${hiringCase.candidateName}. Saving also posts it to Accounting as an expense (category Recruiting). Nobody is paid.`
            : `Charged to ${hiringCase.candidateName}. It is saved here and marked Not posted until someone with ${ACCOUNTING_POST_PERMISSION} posts it to Accounting.`
      }
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={create.isPending || uploading} onClick={() => void save()}>
            {mode === 'accounting' ? 'Attribute expense' : 'Record cost'}
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-testid="add-cost-form">
        {create.error && Object.keys(server).length === 0 ? (
          <div className="sm:col-span-2">
            <Alert tone="danger" title="Not recorded" description={create.error instanceof ApiError ? create.error.message : 'Failed.'} />
          </div>
        ) : null}
        {canSeeAccounting ? (
          <div className="flex flex-wrap gap-1 sm:col-span-2" role="group" aria-label="Where the cost comes from">
            <Button size="sm" variant={mode === 'manual' ? 'primary' : 'ghost'} aria-pressed={mode === 'manual'} onClick={() => setMode('manual')}>
              Enter a cost
            </Button>
            <Button size="sm" variant={mode === 'accounting' ? 'primary' : 'ghost'} aria-pressed={mode === 'accounting'} onClick={() => setMode('accounting')}>
              Already booked in Accounting
            </Button>
          </div>
        ) : null}
        <FormField label="Category" required error={err('type')}>
          <Select
            aria-label="Cost type"
            value={form.type}
            onValueChange={(v) => set('type', v)}
            options={[
              { value: '', label: 'Choose…' },
              ...COST_TYPES.map((t) => ({ value: t, label: `${COST_CATEGORY_LABELS[COST_CATEGORY_OF_TYPE[t]]} · ${COST_TYPE_LABELS[t]}` })),
            ]}
          />
        </FormField>
        {mode === 'manual' ? (
          <>
            <FormField label="Amount ($)" required error={err('amount')}>
              <Input prefix="$" type="number" min="0" step="0.01" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
            </FormField>
            <FormField label="Date" required error={err('incurredOn')}>
              <DatePicker aria-label="Date" value={form.incurredOn} onIsoChange={(e) => set('incurredOn', e)} />
            </FormField>
            <FormField label="Receipt" error={uploadError ?? err('receiptFileId')} description="PDF or photo, optional.">
              <div className="flex min-w-0 items-center gap-2">
                <Button variant="outline" size="sm" icon={<Upload />} onClick={() => input.current?.click()}>
                  {file ? 'Replace' : 'Attach'}
                </Button>
                <span className="truncate text-sm text-muted">{file?.name ?? 'None attached'}</span>
                <input
                  ref={input}
                  type="file"
                  accept="application/pdf,image/*"
                  aria-label="Receipt file"
                  className="hidden"
                  onChange={(e) => {
                    setFile(e.target.files?.[0] ?? null);
                    setReceiptId(null);
                    setUploadError(null);
                  }}
                />
              </div>
            </FormField>
          </>
        ) : (
          <FormField
            label="Accounting expense"
            required
            error={err('accountingExpenseId')}
            description={
              expenses.isPending
                ? 'Loading…'
                : expenses.error
                  ? 'Accounting expenses could not be loaded.'
                  : 'Amount, date and receipt come from the expense. One expense can back only one candidate cost.'
            }
          >
            <Select
              aria-label="Accounting expense"
              value={form.expenseId}
              onValueChange={(v) => set('expenseId', v)}
              options={[
                { value: '', label: 'Choose an expense…' },
                ...(expenses.data ?? [])
                  // An expense a candidate cost posted already belongs to that cost.
                  .filter((e) => e.status !== 'void' && e.source !== 'recruiting')
                  .sort((a, b) => b.onDate.localeCompare(a.onDate))
                  .map((e) => ({ value: e.id, label: `${e.expenseNumber} · ${formatIsoDate(e.onDate)} · ${money(e.amount)} · ${e.description}` })),
              ]}
            />
          </FormField>
        )}
        {mode === 'accounting' && expense ? (
          <p className="text-xs text-muted sm:col-span-2">
            {expense.expenseNumber}: {money(expense.amount)} on {formatIsoDate(expense.onDate)}
            {expense.receiptFileId ? ' · receipt on file' : ' · no receipt on file'}
          </p>
        ) : null}
        <div className="sm:col-span-2">
          <FormField label="Description" error={err('note')}>
            <Textarea rows={2} value={form.note} onChange={(e) => set('note', e.target.value)} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

function VoidCostModal({ entry, onClose }: { entry: CostEntry; onClose: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [tried, setTried] = useState(false);
  const voidIt = useHiringMutation(() => hiringApi.voidCost(entry.id, reason.trim()));
  const canPost = useAccount()?.permissions.includes(ACCOUNTING_POST_PERMISSION) ?? false;
  const posted = entry.accounting?.state === 'posted' || entry.accounting?.state === 'needs_update';
  return (
    <Modal
      open
      size="sm"
      onOpenChange={(o) => !o && onClose()}
      title="Void this cost?"
      description={`${COST_TYPE_LABELS[entry.type]} · ${money(entry.amount)} on ${formatIsoDate(entry.incurredOn)}. It stays on record, struck through, and stops counting in every total.${
        posted
          ? ` Its Accounting expense ${entry.accounting?.expenseNumber} is voided with it (a reversing entry; nothing is deleted).`
          : entry.accounting?.state === 'attributed'
            ? ` The Accounting expense it was attributed from (${entry.accounting?.expenseNumber}) stays in Accounting.`
            : ''
      }`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={voidIt.isPending}
            onClick={() => {
              setTried(true);
              if (!reason.trim()) return;
              voidIt.mutate(undefined, {
                onSuccess: () => {
                  toast({ tone: 'success', title: 'Cost voided' });
                  onClose();
                },
              });
            }}
          >
            Void entry
          </Button>
        </>
      }
    >
      {voidIt.error ? (
        <Alert tone="danger" title="Not voided" description={voidIt.error instanceof ApiError ? voidIt.error.message : 'Failed.'} />
      ) : posted && !canPost ? (
        <Alert
          tone="warning"
          title="Needs Accounting"
          description={`Voiding this cost also voids ${entry.accounting?.expenseNumber} in Accounting, which needs someone with ${ACCOUNTING_POST_PERMISSION}. The server will refuse it for you.`}
        />
      ) : null}
      <FormField label="Reason" required error={tried && !reason.trim() ? 'Say why the entry is voided' : (fieldErrors(voidIt.error).reason ?? null)}>
        <Textarea rows={3} value={reason} onChange={(e) => setReason(e.target.value)} />
      </FormField>
    </Modal>
  );
}
