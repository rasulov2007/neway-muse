import { useState } from 'react';
import { Archive, ArchiveRestore, KeyRound, Plug, Plus, RefreshCw, Satellite, Search } from 'lucide-react';
import {
  INTEGRATION_CATEGORY_LABELS,
  INTEGRATION_STATUS_LABELS,
  type IntegrationAccount,
  type IntegrationCategory,
  type SyncReport,
  type SyncVehicleLine,
} from '@neway/shared';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  FormField,
  Input,
  Modal,
  PageHeader,
  Tabs,
  TabsContent,
  useToast,
} from '@/design-system';
import { useQueryClient } from '@tanstack/react-query';
import { invalidateRoster } from '@/demo/roster-api';
import { EmailCard } from './EmailCard';
import { ApiError } from '@/lib/api-client';
import { formatDateTime, formatNumber } from '@/lib/format';
import {
  CredentialHint,
  IntegrationStatusBadge,
  PermissionGate,
} from './components/AdminKit';
import {
  adminApi,
  useAdminMutation,
  useHasPermission,
  usePermissionCheck,
  useIntegrations,
  type IntegrationView,
} from './useAdmin';

export function IntegrationsPage() {
  const check = usePermissionCheck('integrations.view');
  return (
    <PermissionGate check={check} permission="integrations.view" what="integrations">
      <IntegrationsPageContent />
    </PermissionGate>
  );
}

/** What a modal is for: adding an account to a provider, or replacing one account's key. */
type CredentialTarget =
  | { kind: 'add'; integration: IntegrationView }
  | { kind: 'replace'; integration: IntegrationView; account: IntegrationAccount };

/**
 * Integrations.
 *
 * One card per provider, and under it every account the company holds with that provider — a
 * carrier with two Samsara organisations sees two rows, each with its own key, status, last sync
 * and errors, and "Add account" stays available after the first. The provider is not the thing
 * that has a token; the account is.
 *
 * A stored secret is never shown again. The server does not return it, so the browser has never
 * held it; the only affordance is "Replace", which is also the right operation when a key might
 * have leaked. "Connected" is a badge the provider earns by answering, not one storing a key gets.
 *
 * For Samsara, Motive and Five ELD there is a sync. It always has a preview — what would change, changing nothing —
 * and the report it shows is the same report an applied run produces, so what was previewed is
 * what happens.
 */
function IntegrationsPageContent() {
  const canManage = useHasPermission('integrations.manage');
  const integrations = useIntegrations();

  const [credentialTarget, setCredentialTarget] = useState<CredentialTarget | null>(null);
  const [disconnecting, setDisconnecting] = useState<{ integration: IntegrationView; account: IntegrationAccount } | null>(null);
  const [syncing, setSyncing] = useState<{ integration: IntegrationView; account: IntegrationAccount } | null>(null);
  const [archiving, setArchiving] = useState<IntegrationAccount | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  const byCategory = new Map<IntegrationCategory, IntegrationView[]>();
  for (const integration of integrations.data?.integrations ?? []) {
    const list = byCategory.get(integration.category) ?? [];
    list.push(integration);
    byCategory.set(integration.category, list);
  }

  const accounts = (integrations.data?.integrations ?? []).flatMap((i) => i.accounts);
  const withKey = accounts.filter((a) => a.credentialHint).length;
  const connected = accounts.filter((a) => a.status === 'connected').length;
  // Archived accounts are hidden and never counted; they stay on record behind "Show archived".
  const archivedCount = (integrations.data?.integrations ?? []).reduce((n, i) => n + (i.archivedAccounts?.length ?? 0), 0);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Integrations"
        description="The external systems this carrier uses, one account per organisation."
      />

      {integrations.data ? (
        <Alert tone="info" title="What syncs">
          {integrations.data.note}
        </Alert>
      ) : null}

      <EmailCard canManage={canManage} />

      <p className="text-sm text-muted">
        {accounts.length === 0
          ? 'No accounts yet.'
          : `${accounts.length} ${accounts.length === 1 ? 'account' : 'accounts'} · ${withKey} with a credential · ${connected} connected.`}
        {archivedCount > 0 ? (
          <>
            {' '}
            <button
              type="button"
              className="text-xs font-medium text-primary-text underline-offset-2 hover:underline"
              aria-pressed={showArchived}
              onClick={() => setShowArchived((v) => !v)}
            >
              {showArchived ? `Hide archived (${archivedCount})` : `Show archived (${archivedCount})`}
            </button>
          </>
        ) : null}
      </p>

      {[...byCategory.entries()].map(([category, list]) => (
        <section key={category} className="flex flex-col gap-2">
          <h2 className="eyebrow">{INTEGRATION_CATEGORY_LABELS[category]}</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {list.map((integration) => (
              <Card key={integration.provider} className="flex flex-col gap-3 p-4">
                <header className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="flex items-center gap-2 text-md font-bold text-ink">
                      <Plug aria-hidden className="size-4 text-muted" />
                      {integration.name}
                    </h3>
                    <p className="mt-0.5 text-xs text-muted">{integration.description}</p>
                  </div>
                  {canManage ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Plus />}
                      onClick={() => setCredentialTarget({ kind: 'add', integration })}
                    >
                      {integration.accounts.length === 0 ? 'Add account' : 'Add another'}
                    </Button>
                  ) : null}
                </header>

                <div className="flex flex-col gap-1 text-xs text-muted">
                  <span className="font-medium text-ink">
                    {integration.connector.implemented ? (integration.category === 'communication' ? 'Sends' : integration.category === 'ai' ? 'Provides' : 'Syncs') : 'Would sync'}
                  </span>
                  <span>{integration.wouldSync.join(' · ')}</span>
                </div>

                {!integration.connector.implemented ? (
                  <p className="rounded-md bg-surface-sunken px-2.5 py-2 text-xs text-muted">
                    {integration.connector.reason}
                  </p>
                ) : null}

                {integration.accounts.length === 0 ? (
                  <p className="border-t border-line pt-3 text-xs text-muted">No account added.</p>
                ) : (
                  <ul className="flex flex-col divide-y divide-line border-t border-line">
                    {integration.accounts.map((account) => (
                      <AccountRow
                        key={account.id}
                        integration={integration}
                        account={account}
                        canManage={canManage}
                        onReplace={() => setCredentialTarget({ kind: 'replace', integration, account })}
                        onRemove={() => setDisconnecting({ integration, account })}
                        onSync={() => setSyncing({ integration, account })}
                        onArchive={() => setArchiving(account)}
                      />
                    ))}
                  </ul>
                )}

                {showArchived && (integration.archivedAccounts?.length ?? 0) > 0 ? (
                  <ul className="flex flex-col divide-y divide-line border-t border-dashed border-line" aria-label={`Archived ${integration.name} accounts`}>
                    {(integration.archivedAccounts ?? []).map((account) => (
                      <ArchivedAccountRow key={account.id} account={account} canManage={canManage} />
                    ))}
                  </ul>
                ) : null}
              </Card>
            ))}
          </div>
        </section>
      ))}

      {credentialTarget ? (
        <CredentialModal target={credentialTarget} onClose={() => setCredentialTarget(null)} />
      ) : null}
      {disconnecting ? (
        <DisconnectDialog
          integration={disconnecting.integration}
          account={disconnecting.account}
          onClose={() => setDisconnecting(null)}
        />
      ) : null}
      {archiving ? <ArchiveDialog account={archiving} onClose={() => setArchiving(null)} /> : null}
      {syncing ? (
        <SyncModal
          integration={syncing.integration}
          account={syncing.account}
          onClose={() => setSyncing(null)}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------------------------- one account

function AccountRow({
  integration,
  account,
  canManage,
  onReplace,
  onRemove,
  onSync,
  onArchive,
}: {
  integration: IntegrationView;
  account: IntegrationAccount;
  canManage: boolean;
  onReplace: () => void;
  onRemove: () => void;
  onSync: () => void;
  onArchive: () => void;
}) {
  const { toast } = useToast();
  const test = useAdminMutation(() => adminApi.testIntegration(account.id));
  const toggle = useAdminMutation((status: string) => adminApi.setIntegrationStatus(account.id, status));
  const disabled = account.status === 'disabled';
  const hasKey = Boolean(account.credentialHint);
  const canSync = integration.connector.implemented && hasKey && !disabled;

  const runTest = async () => {
    try {
      const result = await test.mutateAsync(undefined);
      toast({
        tone: 'success',
        title: `${account.name} answered`,
        description: result.organisation ?? undefined,
      });
    } catch (caught) {
      toast({
        tone: 'danger',
        title: `${account.name} did not connect`,
        description: caught instanceof ApiError ? caught.message : 'The provider could not be reached',
      });
    }
  };

  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">{account.name}</span>
            <IntegrationStatusBadge
              status={account.status}
              label={INTEGRATION_STATUS_LABELS[account.status]}
            />
          </span>
          <span className="mt-0.5 block text-xs text-muted">
            {account.externalName ? `Organisation: ${account.externalName} · ` : ''}
            <CredentialHint hint={account.credentialHint} updatedAt={account.credentialUpdatedAt} />
          </span>
        </div>
        {canManage ? (
          <div className="flex min-w-0 flex-wrap gap-1.5">
            {canSync ? (
              <>
                <Button variant="ghost" size="sm" icon={<Satellite />} loading={test.isPending} onClick={() => void runTest()}>
                  Test
                </Button>
                {/* Twilio sends recruiting texts, RTS takes uploads and Azure Speech reads aloud; none has anything to sync. */}
                {integration.category !== 'communication' && integration.category !== 'ai' && integration.provider !== 'rts' ? (
                  <Button variant="secondary" size="sm" icon={<RefreshCw />} onClick={onSync}>
                    Sync
                  </Button>
                ) : null}
              </>
            ) : null}
            {hasKey ? (
              <Button
                variant="ghost"
                size="sm"
                loading={toggle.isPending}
                onClick={() => void toggle.mutateAsync(disabled ? 'credentials_stored' : 'disabled')}
              >
                {disabled ? 'Enable' : 'Disable'}
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" icon={<KeyRound />} onClick={onReplace}>
              {hasKey ? 'Replace' : 'Add key'}
            </Button>
            {hasKey ? (
              <Button variant="ghost" size="sm" onClick={onRemove}>
                Remove
              </Button>
            ) : (
              // No credential, nothing to remove: the way to get rid of the account is to archive it.
              <Button variant="ghost" size="sm" icon={<Archive />} onClick={onArchive}>
                Archive
              </Button>
            )}
          </div>
        ) : null}
      </div>

      {/* What the last run did, as counts; the words are on the report. */}
      {account.lastSyncAt ? (
        <p className="text-xs text-muted">
          Last sync {formatDateTime(account.lastSyncAt)}
          {account.lastSummary
            ? ` · ${account.lastSummary.updated} updated · ${account.lastSummary.created} created · ${account.lastSummary.inactive} inactive · ${account.lastSummary.duplicates} duplicates · ${account.lastSummary.unmatched} unmatched · ${account.lastSummary.conflicts} conflicts`
            : ''}
        </p>
      ) : null}
      {account.lastError ? (
        <p className="text-xs text-danger-text">
          {account.lastError}
          {account.errorCount > 1 ? ` (${account.errorCount} times)` : ''}
        </p>
      ) : null}
    </li>
  );
}

/** An archived account, shown only behind "Show archived": what it was, and the way back. */
function ArchivedAccountRow({ account, canManage }: { account: IntegrationAccount; canManage: boolean }) {
  const { toast } = useToast();
  const unarchive = useAdminMutation(() => adminApi.unarchiveIntegration(account.id));
  const restore = async () => {
    try {
      await unarchive.mutateAsync(undefined);
      toast({ tone: 'success', title: `${account.name} is back in the list` });
    } catch (caught) {
      toast({ tone: 'danger', title: 'Not unarchived', description: caught instanceof ApiError ? caught.message : undefined });
    }
  };
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-3">
      <div className="min-w-0">
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-muted">{account.name}</span>
          <IntegrationStatusBadge status={account.status} label={INTEGRATION_STATUS_LABELS[account.status]} />
        </span>
        {account.config.clientNumber || account.externalName ? (
          <span className="mt-0.5 block text-xs text-muted">
            {account.externalName ? `Organisation: ${account.externalName}` : `Client number: ${account.config.clientNumber}`}
          </span>
        ) : null}
      </div>
      {canManage ? (
        <Button variant="ghost" size="sm" icon={<ArchiveRestore />} loading={unarchive.isPending} onClick={() => void restore()}>
          Unarchive
        </Button>
      ) : null}
    </li>
  );
}

// ---------------------------------------------------------------------------- credentials

function CredentialModal({ target, onClose }: { target: CredentialTarget; onClose: () => void }) {
  const { toast } = useToast();
  const { integration } = target;
  const [name, setName] = useState(
    target.kind === 'add'
      ? integration.accounts.length === 0
        ? integration.name
        : `${integration.name} ${integration.accounts.length + 1}`
      : target.account.name,
  );
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const add = useAdminMutation(adminApi.connectIntegration);
  const replace = useAdminMutation((credentials: Record<string, string>) =>
    adminApi.replaceIntegrationCredential(target.kind === 'replace' ? target.account.id : '', credentials),
  );

  const submit = async () => {
    setError(null);
    // A blank optional field is left out; the server uses its default.
    const credentials = Object.fromEntries(Object.entries(values).filter(([, value]) => value.trim() !== ''));
    try {
      if (target.kind === 'add') {
        await add.mutateAsync({ provider: integration.provider, name: name.trim() || undefined, credentials });
        toast({ title: `${name.trim() || integration.name} added`, tone: 'success' });
      } else {
        await replace.mutateAsync(credentials);
        toast({ title: `Credential replaced for ${target.account.name}`, tone: 'success' });
      }
      // Nothing is echoed back: the values are cleared here and the server never returns them.
      setValues({});
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not store the credential');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={target.kind === 'add' ? `Add a ${integration.name} account` : `Replace the key for ${target.account.name}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={add.isPending || replace.isPending}>
            {target.kind === 'add' ? 'Add account' : 'Replace credential'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not stored">
            {error}
          </Alert>
        ) : null}

        <Alert tone="info" title="Stored encrypted, never shown again">
          Secret fields are encrypted before they reach the database and are not returned by any
          endpoint. Afterwards you will see only the last four characters, which is enough to tell
          two keys apart.
        </Alert>

        {!integration.connector.implemented ? (
          <Alert tone="warning" title="Nothing will sync yet">
            {integration.connector.reason}
          </Alert>
        ) : null}

        {target.kind === 'add' ? (
          <FormField label="Account name" description="Your name for it: which organisation, which yard.">
            <Input value={name} onChange={(event) => setName(event.target.value)} />
          </FormField>
        ) : null}

        {integration.credentialFields.map((field) => (
          <FormField key={field.name} label={field.label} description={field.help} required={!field.optional}>
            <Input
              type={field.kind === 'secret' ? 'password' : 'text'}
              autoComplete="off"
              value={values[field.name] ?? ''}
              onChange={(event) => setValues({ ...values, [field.name]: event.target.value })}
            />
          </FormField>
        ))}
      </div>
    </Modal>
  );
}

function DisconnectDialog({
  integration,
  account,
  onClose,
}: {
  integration: IntegrationView;
  account: IntegrationAccount;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const mutation = useAdminMutation(() => adminApi.disconnectIntegration(account.id));

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Remove the credential from ${account.name}?`}
      description={`The stored ${integration.name} secret is destroyed. The account, and its sync history, are kept.`}
      confirmLabel="Remove credential"
      tone="danger"
      onConfirm={async () => {
        await mutation.mutateAsync(undefined);
        toast({ title: `${account.name} credential removed`, tone: 'success' });
        onClose();
      }}
    />
  );
}

function ArchiveDialog({ account, onClose }: { account: IntegrationAccount; onClose: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const mutation = useAdminMutation(() => adminApi.archiveIntegration(account.id, reason.trim() || undefined));

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Archive this account?"
      description="It is hidden from the list and kept on record."
      confirmLabel="Archive"
      onConfirm={async () => {
        try {
          await mutation.mutateAsync(undefined);
        } catch (caught) {
          toast({ tone: 'danger', title: 'Not archived', description: caught instanceof ApiError ? caught.message : undefined });
          throw caught;
        }
        toast({ title: `${account.name} archived`, tone: 'success' });
        onClose();
      }}
    >
      <FormField label="Reason" description="Optional. Kept in the audit log.">
        <Input value={reason} onChange={(event) => setReason(event.target.value)} />
      </FormField>
    </ConfirmDialog>
  );
}

// ----------------------------------------------------------------------------------- sync

const BUCKETS: { key: keyof Pick<SyncReport, 'updated' | 'created' | 'unmatched' | 'duplicates' | 'inactive' | 'conflicts' | 'unchanged'>; label: string }[] = [
  { key: 'updated', label: 'Updated' },
  { key: 'created', label: 'Created' },
  { key: 'unmatched', label: 'Unmatched' },
  { key: 'duplicates', label: 'Duplicates' },
  { key: 'inactive', label: 'Inactive' },
  { key: 'conflicts', label: 'Conflicts' },
  { key: 'unchanged', label: 'Unchanged' },
];

/**
 * Preview, then apply.
 *
 * The preview is the same run with `dryRun`, so the report on screen is what an apply would do —
 * not a guess about it. "Create missing" is a per-run choice, off by default, because inventing
 * trucks is the one thing here that should never happen unattended.
 */
function SyncModal({
  integration,
  account,
  onClose,
}: {
  integration: IntegrationView;
  account: IntegrationAccount;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [createMissing, setCreateMissing] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<string>('updated');
  const run = useAdminMutation((dryRun: boolean) =>
    adminApi.syncIntegration(account.id, { dryRun, createMissing }),
  );

  const go = async (dryRun: boolean) => {
    setError(null);
    try {
      const result = await run.mutateAsync(dryRun);
      setReport(result);
      const first = BUCKETS.find((b) => result[b.key].length > 0);
      if (first) setTab(first.key);
      if (!dryRun) {
        // The roster is loaded once per session; a sync that wrote to it is the reason to reload
        // it, or the Trucks page keeps showing the fleet as it was before the trucks arrived.
        invalidateRoster();
        await queryClient.invalidateQueries({ queryKey: ['fleet'] });
        await queryClient.invalidateQueries({ queryKey: ['roster'] });
        toast({
          tone: 'success',
          title: `${account.name} synced`,
          description: `${result.summary.updated} updated · ${result.summary.created} created`,
        });
      }
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'The sync failed');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Sync ${account.name}`}
      description={`${integration.name} → the truck roster. Read-only against ${integration.name}.`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
          <Button variant="secondary" icon={<Search />} loading={run.isPending} onClick={() => void go(true)}>
            Preview
          </Button>
          <Button
            variant="primary"
            icon={<RefreshCw />}
            loading={run.isPending}
            disabled={report === null || !report.dryRun}
            onClick={() => void go(false)}
          >
            Apply
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not synced">
            {error}
          </Alert>
        ) : null}

        <Checkbox
          checked={createMissing}
          onCheckedChange={(checked) => setCreateMissing(checked === true)}
          label="Create trucks for vehicles the roster does not have"
          description="Only vehicles with a VIN and a recent odometer. Inactive and duplicate vehicles are never created."
        />

        {report === null ? (
          <p className="text-sm text-muted">
            Preview first. It reads {integration.name} and shows what an apply would change, without changing it.
          </p>
        ) : (
          <>
            <Alert tone={report.dryRun ? 'info' : 'success'} title={report.dryRun ? 'Preview — nothing changed' : 'Applied'}>
              {formatNumber(report.summary.fetched)} vehicles read · {report.summary.matched} matched ·{' '}
              {report.summary.updated} {report.dryRun ? 'would update' : 'updated'} · {report.summary.created}{' '}
              {report.dryRun ? 'would be created' : 'created'} · {report.summary.inactive} inactive ·{' '}
              {report.summary.duplicates} duplicates · {report.summary.unmatched} unmatched ·{' '}
              {report.summary.conflicts} conflicts
            </Alert>

            <Tabs
              value={tab}
              onValueChange={setTab}
              items={BUCKETS.map((b) => ({ value: b.key, label: `${b.label} (${report[b.key].length})` }))}
            >
              {BUCKETS.map((b) => (
                <TabsContent key={b.key} value={b.key}>
                  <LineList lines={report[b.key]} providerName={integration.name} />
                </TabsContent>
              ))}
            </Tabs>
          </>
        )}
      </div>
    </Modal>
  );
}

function LineList({ lines, providerName }: { lines: SyncVehicleLine[]; providerName: string }) {
  if (lines.length === 0) {
    return <p className="py-3 text-sm text-muted">Nothing here.</p>;
  }
  return (
    <ul className="max-h-80 divide-y divide-line overflow-y-auto text-sm">
      {lines.map((line) => (
        <li key={`${line.externalId}-${line.note}`} className="flex flex-col gap-0.5 py-2">
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-semibold text-ink">{line.unitNumber ?? line.name}</span>
            {line.unitNumber && line.unitNumber !== line.name ? (
              <span className="text-xs text-muted">{providerName}: {line.name}</span>
            ) : null}
            {line.vin ? <span className="text-xs text-muted">VIN {line.vin}</span> : null}
            {line.lastSeenAt ? (
              <span className="text-xs text-muted">last seen {formatDateTime(line.lastSeenAt)}</span>
            ) : null}
          </span>
          <span className="text-xs text-secondary">{line.note}</span>
        </li>
      ))}
    </ul>
  );
}
