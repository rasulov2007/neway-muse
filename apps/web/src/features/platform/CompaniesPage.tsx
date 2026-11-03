import { useState } from 'react';
import { Building, KeyRound, Pencil, Plus, Power } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PlatformCompany, PlatformCredential } from '@neway/shared';
import {
  Alert,
  Button,
  Card,
  FormField,
  Input,
  Modal,
  PageHeader,
  StatusBadge,
  Textarea,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { TemporaryCredentialDialog } from '@/features/admin/TemporaryCredentialDialog';
import { ApiError, apiGet, apiPatch, apiPost } from '@/lib/api-client';
import { formatDate, formatDateTime } from '@/lib/format';

const BASE = '/platform/companies';
const KEY = ['platform', 'companies'] as const;

function useCompanies() {
  return useQuery({ queryKey: KEY, queryFn: () => apiGet<PlatformCompany[]>(BASE) });
}

function usePlatformMutation<TInput, TResult>(fn: (input: TInput) => Promise<TResult>) {
  const client = useQueryClient();
  return useMutation<TResult, unknown, TInput>({
    mutationFn: fn,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: KEY });
    },
  });
}

const message = (caught: unknown, fallback: string) =>
  caught instanceof ApiError ? caught.message : fallback;

/**
 * Companies (platform administrator only, owner 2026-10-01).
 *
 * Where a new customer company is opened with its first administrator, and where an existing one is
 * renamed, given a new administrator password, or deactivated. A deactivated company is hidden,
 * kept and reversible: its people cannot sign in until it is reactivated.
 */
export function CompaniesPage() {
  const account = useAccount();
  if (!account?.isPlatformAdmin) {
    return (
      <Alert tone="info" title="Platform administrators only">
        This page is for the person who opens new customer companies.
      </Alert>
    );
  }
  return <CompaniesPageContent />;
}

type Dialog =
  | { kind: 'create' }
  | { kind: 'rename'; company: PlatformCompany }
  | { kind: 'deactivate'; company: PlatformCompany }
  | { kind: 'credential'; credential: PlatformCredential }
  | null;

function CompaniesPageContent() {
  const { toast } = useToast();
  const account = useAccount();
  const companies = useCompanies();
  const [dialog, setDialog] = useState<Dialog>(null);
  const reactivate = usePlatformMutation((c: PlatformCompany) =>
    apiPost<PlatformCompany>(`${BASE}/${c.id}/reactivate`, { version: c.version }),
  );
  const reissue = usePlatformMutation((c: PlatformCompany) =>
    apiPost<PlatformCredential>(`${BASE}/${c.id}/admin-password`, {}),
  );

  const rows = companies.data ?? [];
  const active = companies.data ? rows.filter((c) => c.status === 'active').length : null;

  const onReissue = async (company: PlatformCompany) => {
    if (!company.admin) return;
    const ok = window.confirm(
      `Issue a new temporary password for ${company.admin.email}? Their current password stops working and they are signed out.`,
    );
    if (!ok) return;
    try {
      setDialog({ kind: 'credential', credential: await reissue.mutateAsync(company) });
    } catch (caught) {
      toast({ title: message(caught, 'Could not issue a password'), tone: 'danger' });
    }
  };

  const onReactivate = async (company: PlatformCompany) => {
    try {
      await reactivate.mutateAsync(company);
      toast({ title: `${company.name} is active again`, tone: 'success' });
    } catch (caught) {
      toast({ title: message(caught, 'Could not reactivate'), tone: 'danger' });
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Companies"
        description="Customer companies on this platform. Open a new one with its first administrator; nothing is ever deleted."
        actions={
          <Button onClick={() => setDialog({ kind: 'create' })}>
            <Plus aria-hidden className="size-4" />
            New company
          </Button>
        }
      />

      <div className="flex flex-wrap gap-2">
        <Card className="flex min-w-40 flex-col gap-0.5 px-3 py-2">
          <span className="text-xs font-medium text-muted">Companies</span>
          <span className="text-lg font-semibold tabular-nums text-ink">
            {companies.data ? rows.length : 'Loading…'}
          </span>
        </Card>
        <Card className="flex min-w-40 flex-col gap-0.5 px-3 py-2">
          <span className="text-xs font-medium text-muted">Active</span>
          <span className="text-lg font-semibold tabular-nums text-ink">{active ?? 'Loading…'}</span>
        </Card>
      </div>

      <Card className="overflow-x-auto p-0">
        {companies.isLoading ? <p className="p-4 text-sm text-muted">Loading…</p> : null}
        {companies.isError ? (
          <p className="p-4 text-sm text-muted">{message(companies.error, 'Could not load companies')}</p>
        ) : null}
        {companies.data ? (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs font-medium text-muted">
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Administrator</th>
                <th className="px-3 py-2 text-right">Users</th>
                <th className="px-3 py-2">Created</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map((company) => (
                <tr key={company.id} className="border-b border-line last:border-0 align-top">
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <Building aria-hidden className="size-4 shrink-0 text-muted" />
                      <span className="font-medium text-ink">{company.name}</span>
                    </div>
                    <code className="ml-6 font-mono text-xs text-muted">{company.id}</code>
                    {company.id === account?.companyId ? (
                      <span className="ml-2 text-xs text-muted">(you are signed in here)</span>
                    ) : null}
                  </td>
                  <td className="px-3 py-2.5">
                    {company.status === 'active' ? (
                      <StatusBadge status="active" size="sm" />
                    ) : (
                      <div className="flex flex-col gap-1">
                        <StatusBadge status="inactive" label="Deactivated" size="sm" />
                        {company.deactivatedAt ? (
                          <span className="text-xs text-muted">
                            {formatDateTime(company.deactivatedAt)}
                            {company.deactivatedReason ? ` · ${company.deactivatedReason}` : ''}
                          </span>
                        ) : null}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {company.admin ? (
                      <div className="flex flex-col">
                        <span className="text-ink">{company.admin.email}</span>
                        <span className="text-xs text-muted">
                          {company.admin.lastLoginAt
                            ? `Last sign-in ${formatDateTime(company.admin.lastLoginAt)}`
                            : 'Never signed in'}
                        </span>
                      </div>
                    ) : (
                      <span className="text-muted">No owner administrator</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right tabular-nums text-ink">{company.userCount}</td>
                  <td className="px-3 py-2.5 text-muted">{formatDate(company.createdAt)}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap justify-end gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        icon={<Pencil />}
                        onClick={() => setDialog({ kind: 'rename', company })}
                      >
                        Rename
                      </Button>
                      {company.admin && company.status === 'active' ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          icon={<KeyRound />}
                          loading={reissue.isPending && reissue.variables?.id === company.id}
                          onClick={() => void onReissue(company)}
                        >
                          New admin password
                        </Button>
                      ) : null}
                      {company.status === 'active' ? (
                        company.id === account?.companyId ? null : (
                          <Button
                            variant="ghost"
                            size="sm"
                            icon={<Power />}
                            onClick={() => setDialog({ kind: 'deactivate', company })}
                          >
                            Deactivate
                          </Button>
                        )
                      ) : (
                        <Button
                          variant="secondary"
                          size="sm"
                          icon={<Power />}
                          loading={reactivate.isPending && reactivate.variables?.id === company.id}
                          onClick={() => void onReactivate(company)}
                        >
                          Reactivate
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </Card>

      {dialog?.kind === 'create' ? (
        <CreateCompanyModal
          onClose={() => setDialog(null)}
          onCreated={(credential) => setDialog({ kind: 'credential', credential })}
        />
      ) : null}
      {dialog?.kind === 'rename' ? (
        <RenameCompanyModal company={dialog.company} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'deactivate' ? (
        <DeactivateCompanyModal company={dialog.company} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'credential' ? (
        <TemporaryCredentialDialog
          email={dialog.credential.email}
          temporaryPassword={dialog.credential.temporaryPassword}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </div>
  );
}

function CreateCompanyModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (credential: PlatformCredential) => void;
}) {
  const [form, setForm] = useState({ name: '', adminEmail: '', adminFirstName: '', adminLastName: 'Admin' });
  const [error, setError] = useState<string | null>(null);
  const create = usePlatformMutation((input: typeof form) => apiPost<PlatformCredential>(BASE, input));

  const submit = async () => {
    setError(null);
    try {
      onCreated(await create.mutateAsync(form));
    } catch (caught) {
      setError(message(caught, 'Could not create the company'));
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title="New company"
      description="An empty workspace with one administrator. The administrator gets a temporary password to change at first sign-in."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={create.isPending}>
            Create company
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not created">
            {error}
          </Alert>
        ) : null}
        <FormField label="Company name" required>
          <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Harbor Line Transport" />
        </FormField>
        <FormField label="Administrator email" required description="They sign in with this address.">
          <Input
            type="email"
            value={form.adminEmail}
            onChange={(e) => setForm({ ...form, adminEmail: e.target.value })}
            placeholder="admin@company.com"
          />
        </FormField>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <FormField label="First name" required>
            <Input value={form.adminFirstName} onChange={(e) => setForm({ ...form, adminFirstName: e.target.value })} />
          </FormField>
          <FormField label="Last name">
            <Input value={form.adminLastName} onChange={(e) => setForm({ ...form, adminLastName: e.target.value })} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

function RenameCompanyModal({ company, onClose }: { company: PlatformCompany; onClose: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(company.name);
  const [error, setError] = useState<string | null>(null);
  const rename = usePlatformMutation((input: { name: string; version: string }) =>
    apiPatch<PlatformCompany>(`${BASE}/${company.id}`, input),
  );

  const submit = async () => {
    setError(null);
    try {
      await rename.mutateAsync({ name, version: company.version });
      toast({ title: `Renamed to ${name.trim()}`, tone: 'success' });
      onClose();
    } catch (caught) {
      setError(message(caught, 'Could not rename'));
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Rename ${company.name}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={rename.isPending}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not saved">
            {error}
          </Alert>
        ) : null}
        <FormField label="Company name" required>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}

function DeactivateCompanyModal({ company, onClose }: { company: PlatformCompany; onClose: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const deactivate = usePlatformMutation((input: { reason: string; version: string }) =>
    apiPost<PlatformCompany>(`${BASE}/${company.id}/deactivate`, input),
  );

  const submit = async () => {
    setError(null);
    try {
      await deactivate.mutateAsync({ reason, version: company.version });
      toast({ title: `${company.name} deactivated`, tone: 'success' });
      onClose();
    } catch (caught) {
      setError(message(caught, 'Could not deactivate'));
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Deactivate ${company.name}?`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" onClick={() => void submit()} loading={deactivate.isPending}>
            Deactivate
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Alert tone="warning" title="Its people are signed out">
          Nobody in {company.name} can sign in until it is reactivated. Nothing is deleted.
        </Alert>
        {error ? (
          <Alert tone="danger" title="Not saved">
            {error}
          </Alert>
        ) : null}
        <FormField label="Reason" required>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
