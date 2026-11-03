import { useMemo, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Plus, Search, Users, X } from 'lucide-react';
import {
  ACCOUNT_STATUSES,
  ACCOUNT_STATUS_MEANING,
  ASSIGNABLE_ACCOUNT_STATUSES,
  PASSWORD_MIN_LENGTH,
  type AdminAccount,
} from '@neway/shared';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Checkbox,
  DataTable,
  Drawer,
  FormField,
  Input,
  Modal,
  PageHeader,
  Select,
  StatusSymbol,
  Textarea,
  Timeline,
  cn,
  createColumns,
  useToast,
} from '@/design-system';
import { TemporaryCredentialDialog } from './TemporaryCredentialDialog';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import {
  Absent,
  AccountStatusBadge,
  Detail,
  PermissionGate,
} from './components/AdminKit';
import { adminSearchSchema } from './admin-search';
import {
  type CreatedAdminAccount,
  adminApi,
  useAccount,
  useAccountActivity,
  useAccountPermissions,
  useAccountSummary,
  useAccounts,
  useAdminMutation,
  useHasPermission,
  usePermissionCheck,
  useInvitationDelivery,
  useLinkableEmployees,
  useRoles,
} from './useAdmin';

const col = createColumns<AdminAccount>();

type StatusFamily = 'done' | 'moving' | 'warning' | 'neutral';
/** Written out so the class names are in the source for Tailwind to find. */
const FAMILY_TEXT: Record<StatusFamily, string> = {
  done: 'text-nw-done-text',
  moving: 'text-nw-moving-text',
  warning: 'text-nw-warning-text',
  neutral: 'text-ink',
};
const FAMILY_ICON: Record<StatusFamily, string> = {
  done: 'text-nw-done-icon',
  moving: 'text-nw-moving-icon',
  warning: 'text-nw-warning-icon',
  neutral: 'text-nw-neutral-icon',
};

export function UsersPage() {
  const check = usePermissionCheck('users.view');
  return (
    <PermissionGate check={check} permission="users.view" what="accounts">
      <UsersPageContent />
    </PermissionGate>
  );
}

/**
 * Accounts.
 *
 * Every row here is a *membership* — one person's access to this company. That is why the list can
 * show an administrator with no employee record beside a dispatcher with one, and why the 70
 * drivers on this fleet appear nowhere: they have no login, which is the point of keeping user,
 * employee and driver as three records rather than one.
 */
function UsersPageContent() {
  const raw = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => adminSearchSchema.parse(raw), [raw]);
  const navigate = useNavigate();
  const { toast } = useToast();

  const canCreate = useHasPermission('users.create');
  const canEdit = useHasPermission('users.edit');
  const canAssign = useHasPermission('users.assign');

  const [createOpen, setCreateOpen] = useState(false);
  // The one-time credential, held only long enough to show it.
  const [credential, setCredential] = useState<{ email: string; temporaryPassword: string } | null>(
    null,
  );
  const issueTemporary = useAdminMutation(adminApi.issueTemporaryPassword);
  const [rolesFor, setRolesFor] = useState<AdminAccount | null>(null);
  const [statusFor, setStatusFor] = useState<AdminAccount | null>(null);
  const [passwordFor, setPasswordFor] = useState<AdminAccount | null>(null);
  const [emailFor, setEmailFor] = useState<AdminAccount | null>(null);

  const params = useMemo(
    () => ({
      page: search.page,
      pageSize: search.pageSize,
      search: search.q,
      status: search.status,
      roleId: search.roleId,
      profile: search.profile,
    }),
    [search.page, search.pageSize, search.q, search.status, search.roleId, search.profile],
  );

  const accounts = useAccounts(params);
  const summary = useAccountSummary();
  const roles = useRoles();
  const selected = useAccount(search.selected ?? null);

  const setSearch = (patch: Record<string, unknown>) => {
    void navigate({ to: '/admin/users', search: { ...search, page: 1, ...patch } });
  };

  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  const [q, setQ] = useState(search.q ?? '');
  const filtered = Boolean(search.q || search.status || search.roleId || search.profile);

  const issuePassword = (row: AdminAccount) => {
    issueTemporary
      .mutateAsync(row.membershipId)
      .then((created) =>
        setCredential({ email: created.account.email, temporaryPassword: created.temporaryPassword }),
      )
      .catch((caught: unknown) =>
        toast({
          tone: 'danger',
          title: 'Could not issue a temporary password',
          description: caught instanceof ApiError ? caught.message : undefined,
        }),
      );
  };

  const columns = useMemo(
    () => [
      col.accessor('name', {
        header: 'User',
        meta: { primary: true },
        cell: (info) => (
          <div className="flex items-center gap-3">
            <Avatar name={info.getValue()} />
            <div className="flex min-w-0 flex-col">
              <span className="flex items-center gap-1.5 font-semibold text-ink">
                {info.getValue()}
                {info.row.original.isOwner ? (
                  <Badge tone="info" variant="outline" size="sm">
                    Owner
                  </Badge>
                ) : null}
              </span>
              <span className="truncate text-xs text-muted">{info.row.original.email}</span>
            </div>
          </div>
        ),
      }),
      col.accessor('status', {
        header: 'Status',
        cell: (info) => <AccountStatusBadge status={info.getValue()} />,
      }),
      col.accessor('roles', {
        header: 'Role',
        enableSorting: false,
        cell: (info) => {
          const list = info.getValue();
          if (list.length === 0) return <Absent>No role — can do nothing</Absent>;
          return (
            <div className="flex flex-wrap gap-1">
              {list.map((role) => (
                <Badge key={role.id} tone="neutral" variant="soft" size="sm">
                  {role.name}
                </Badge>
              ))}
            </div>
          );
        },
      }),
      col.accessor('employeeName', {
        header: 'Employee record',
        cell: (info) => {
          const name = info.getValue();
          // Complete your profile (2026-10-26): who still has to fill in their own information.
          if (info.row.original.profileStatus === 'pending') {
            return (
              <Badge tone="warning" variant="soft" size="sm" dot title="Held on Complete your profile until they submit it">
                Profile not completed
              </Badge>
            );
          }
          if (!name) return <span className="text-sm text-muted">Not linked</span>;
          return (
            <span className="text-sm">
              {name}
              <span className="ml-1 text-xs text-muted">{info.row.original.employeeNumber}</span>
            </span>
          );
        },
      }),
      col.accessor('lastLoginAt', {
        header: 'Last sign-in',
        cell: (info) => {
          const at = info.getValue();
          return at ? formatDateTime(at) : <span className="text-sm text-muted">Never</span>;
        },
      }),
      col.display({
        id: 'actions',
        header: 'Actions',
        meta: { width: 150 },
        cell: (info) => {
          const row = info.row.original;
          // An invited account has no password yet and no mail transport sends one: the useful
          // action is a temporary password to hand over, not a promise of an email.
          if (row.status === 'invited' && canEdit) {
            return (
              <Button
                variant="outline"
                size="sm"
                loading={issueTemporary.isPending && issueTemporary.variables === row.membershipId}
                onClick={(event) => {
                  event.stopPropagation();
                  issuePassword(row);
                }}
              >
                Issue password
              </Button>
            );
          }
          return (
            <Button
              variant="outline"
              size="sm"
              onClick={(event) => {
                event.stopPropagation();
                setSearch({ selected: row.membershipId });
              }}
            >
              Manage
            </Button>
          );
        },
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canEdit, issueTemporary.isPending, issueTemporary.variables],
  );

  // Total accounts leaves archived ones out (owner, 2026-10-22); they have their own quiet card,
  // which is the only way the list shows them.
  const cards: { key: string; label: string; value: number | null | undefined; family?: StatusFamily; quiet?: boolean }[] = [
    { key: 'all', label: 'Total accounts', value: summary.data?.total },
    { key: 'active', label: 'Active', value: summary.data?.active, family: 'done' },
    { key: 'invited', label: 'Invited', value: summary.data?.invited, family: 'moving' },
    { key: 'suspended', label: 'Suspended', value: summary.data?.suspended, family: 'warning' },
    { key: 'disabled', label: 'Disabled', value: summary.data?.disabled, family: 'neutral' },
    { key: 'archived', label: 'Archived', value: summary.data?.archived, family: 'neutral', quiet: true },
  ];
  const activeCard = search.status ?? 'all';
  const matching = accounts.data?.total ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-sm text-muted">
        <span>Administration</span>
        <span aria-hidden>/</span>
        <span className="text-ink">Users</span>
      </nav>
      <PageHeader
        title="Users & access"
        description="Manage company accounts, roles and sign-in access."
        actions={
          canCreate ? (
            <Button variant="primary" onClick={() => setCreateOpen(true)}>
              <Plus aria-hidden className="size-4" />
              Add account
            </Button>
          ) : null
        }
      />

      <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Accounts by status">
        {cards.map((card) => {
          const on = activeCard === card.key;
          return (
            <button
              key={card.key}
              type="button"
              aria-pressed={on}
              onClick={() => setSearch({ status: card.key === 'all' ? undefined : card.key })}
              className={cn(
                'flex items-center justify-between gap-3 rounded-[10px] border px-5 py-4 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                on ? 'border-primary bg-primary-soft' : 'border-line bg-surface hover:bg-surface-hover',
              )}
            >
              <span className="min-w-0">
                <span className={cn('block text-sm', card.quiet ? 'text-muted' : 'text-secondary')}>{card.label}</span>
                <span
                  className={cn(
                    'tabular block font-bold',
                    card.quiet ? 'text-xl text-muted' : 'text-3xl',
                    !card.quiet && (card.family ? FAMILY_TEXT[card.family] : 'text-primary-text'),
                  )}
                >
                  {summary.isLoading || card.value == null ? 'Loading…' : card.value}
                </span>
              </span>
              {card.family ? (
                <StatusSymbol family={card.family} size={18} className={FAMILY_ICON[card.family]} />
              ) : (
                <span className="flex size-11 items-center justify-center rounded-full bg-primary-soft text-primary-text" aria-hidden>
                  <Users className="size-5" />
                </span>
              )}
            </button>
          );
        })}
      </section>

      <DataTable
        columns={columns}
        data={accounts.data?.data ?? []}
        rowKey={(row) => row.membershipId}
        total={accounts.data?.total}
        serverSide
        state={{
          sorting: [],
          pagination: { page: search.page, pageSize: search.pageSize },
          rowSelection: {},
          columnVisibility,
          globalFilter: '',
        }}
        onStateChange={(patch) => {
          if (patch.pagination) {
            void navigate({ to: '/admin/users', search: { ...search, page: patch.pagination.page, pageSize: patch.pagination.pageSize } });
          }
          if (patch.columnVisibility) setColumnVisibility(patch.columnVisibility);
        }}
        loading={accounts.isLoading}
        error={accounts.error}
        onRetry={() => void accounts.refetch()}
        onRowClick={(row) => setSearch({ selected: row.membershipId })}
        emptyTitle="No accounts match"
        emptyDescription="Change the filters or search for a different name."
        caption="Accounts"
        toolbar={
          <div className="flex w-full flex-col gap-2">
            <div className="flex flex-wrap items-end gap-3">
              <div className="relative w-full max-w-sm">
                <Input
                  prefix={<Search aria-hidden className="size-4" />}
                  placeholder="Search name, email or employee number"
                  value={q}
                  onChange={(event) => {
                    setQ(event.target.value);
                    setSearch({ q: event.target.value || undefined });
                  }}
                  aria-label="Search accounts"
                />
                {q ? (
                  <button
                    type="button"
                    aria-label="Clear search"
                    className="absolute top-1/2 right-2 -translate-y-1/2 rounded p-1 text-muted hover:text-ink"
                    onClick={() => {
                      setQ('');
                      setSearch({ q: undefined });
                    }}
                  >
                    <X className="size-4" />
                  </button>
                ) : null}
              </div>
              <label className="flex flex-col gap-1 text-xs font-semibold text-secondary">
                Status
                <Select
                  options={[
                    { value: '', label: 'All but archived' },
                    ...ACCOUNT_STATUSES.map((st) => ({ value: st, label: st.charAt(0).toUpperCase() + st.slice(1) })),
                  ]}
                  value={search.status ?? ''}
                  onValueChange={(value) => setSearch({ status: value || undefined })}
                  placeholder="All but archived"
                  aria-label="Filter by status"
                  className="w-44"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-secondary">
                Role
                <Select
                  options={[
                    { value: '', label: 'All roles' },
                    ...(roles.data ?? []).map((role) => ({ value: role.id, label: role.name })),
                  ]}
                  value={search.roleId ?? ''}
                  onValueChange={(value) => setSearch({ roleId: value || undefined })}
                  placeholder="All roles"
                  aria-label="Filter by role"
                  className="w-44"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-semibold text-secondary">
                Profile
                <Select
                  options={[
                    { value: '', label: 'Any' },
                    { value: 'pending', label: 'Not completed' },
                  ]}
                  value={search.profile ?? ''}
                  onValueChange={(value) => setSearch({ profile: value || undefined })}
                  placeholder="Any"
                  aria-label="Filter by profile"
                  className="w-40"
                />
              </label>
              {filtered ? (
                <button
                  type="button"
                  className="pb-2 text-sm font-semibold text-primary-text underline"
                  onClick={() => {
                    setQ('');
                    setSearch({ q: undefined, status: undefined, roleId: undefined, profile: undefined });
                  }}
                >
                  Clear filters
                </button>
              ) : null}
            </div>
            <p className="text-xs text-muted">
              {accounts.isLoading
                ? 'Loading…'
                : `${matching} matching account${matching === 1 ? '' : 's'} · ${summary.data?.total ?? '…'} total accounts`}
            </p>
          </div>
        }
        rowActions={
          canEdit || canAssign
            ? (row) => (
                <div className="flex flex-col">
                  <button
                    type="button"
                    className="px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
                    onClick={() => setSearch({ selected: row.membershipId })}
                  >
                    Open account
                  </button>
                  {canAssign && row.status !== 'archived' ? (
                    <button
                      type="button"
                      className="px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
                      onClick={() => setRolesFor(row)}
                    >
                      Change roles
                    </button>
                  ) : null}
                  {canEdit ? (
                    <button
                      type="button"
                      className="px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
                      onClick={() => setStatusFor(row)}
                    >
                      Change status
                    </button>
                  ) : null}
                  {canEdit && row.status !== 'archived' ? (
                    <button
                      type="button"
                      className="px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
                      onClick={() => setEmailFor(row)}
                      data-testid="change-email"
                    >
                      Change email
                    </button>
                  ) : null}
                  {canEdit && row.status !== 'archived' ? (
                    <button
                      type="button"
                      className="px-3 py-1.5 text-left text-sm hover:bg-surface-hover disabled:opacity-50"
                      disabled={issueTemporary.isPending}
                      onClick={() => issuePassword(row)}
                    >
                      Issue temporary password
                    </button>
                  ) : null}
                  {canEdit && row.status !== 'archived' ? (
                    <button
                      type="button"
                      className="px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
                      onClick={() => setPasswordFor(row)}
                    >
                      Set a password by hand
                    </button>
                  ) : null}
                </div>
              )
            : undefined
        }
      />
      <p className="text-xs text-muted">Account totals leave archived accounts out; the Archived card lists them. The list reflects your search and filters.</p>

      <AccountDrawer
        membershipId={search.selected ?? null}
        account={selected.data ?? null}
        onClose={() => setSearch({ selected: undefined })}
      />

      {createOpen ? (
        <CreateAccountModal
          onClose={() => setCreateOpen(false)}
          onCreated={(created) => {
            setCreateOpen(false);
            if (created.temporaryPassword === null) {
              // Already signs in to another company (owner, 2026-10-13): same email and password,
              // and the top bar switches between the companies.
              toast({
                title: `${created.account.email} added to this company`,
                description: 'They already sign in to another company: same email and password. They switch company in the top bar.',
                tone: 'success',
              });
              return;
            }
            toast({ title: `Account created for ${created.account.email}`, tone: 'success' });
            // The password is shown once, here, and never again.
            setCredential({
              email: created.account.email,
              temporaryPassword: created.temporaryPassword,
            });
          }}
        />
      ) : null}

      {credential ? (
        <TemporaryCredentialDialog
          email={credential.email}
          temporaryPassword={credential.temporaryPassword}
          onClose={() => setCredential(null)}
        />
      ) : null}

      {rolesFor ? <RolesModal account={rolesFor} onClose={() => setRolesFor(null)} /> : null}

      {statusFor ? <StatusModal account={statusFor} onClose={() => setStatusFor(null)} /> : null}

      {passwordFor ? (
        <PasswordModal account={passwordFor} onClose={() => setPasswordFor(null)} />
      ) : null}

      {emailFor ? <EmailModal account={emailFor} onClose={() => setEmailFor(null)} /> : null}
    </div>
  );
}

// ------------------------------------------------------------------------------------- drawer

function AccountDrawer({
  membershipId,
  account,
  onClose,
}: {
  membershipId: string | null;
  account: AdminAccount | null;
  onClose: () => void;
}) {
  const permissions = useAccountPermissions(membershipId);
  const activity = useAccountActivity(membershipId);
  const canEdit = useHasPermission('users.edit');
  const [linkOpen, setLinkOpen] = useState(false);

  return (
    <Drawer
      open={membershipId !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={account?.name ?? 'Account'}
      description={account?.email}
      size="lg"
    >
      {account ? (
        <div className="flex flex-col gap-5">
          <dl className="grid grid-cols-2 gap-4">
            <Detail label="Status">
              <div className="flex flex-col gap-1">
                <AccountStatusBadge status={account.status} />
                <span className="text-xs text-muted">{ACCOUNT_STATUS_MEANING[account.status]}</span>
              </div>
            </Detail>
            <Detail label="Linked employee">
              <span className="flex flex-wrap items-center gap-2">
                {account.employeeName ? (
                  `${account.employeeName} · ${account.employeeNumber}`
                ) : (
                  <Absent>Not linked to an employee</Absent>
                )}
                {canEdit ? (
                  <button
                    type="button"
                    className="text-xs font-semibold text-primary-text hover:underline"
                    onClick={() => setLinkOpen(true)}
                  >
                    {account.employeeName ? 'Change' : 'Link'}
                  </button>
                ) : null}
              </span>
            </Detail>
            <Detail label="Invited">
              {account.invitedAt ? formatDateTime(account.invitedAt) : <Absent />}
            </Detail>
            <Detail label="Accepted">
              {account.acceptedAt ? formatDateTime(account.acceptedAt) : <Absent />}
            </Detail>
            <Detail label="Last sign-in">
              {account.lastLoginAt ? formatDateTime(account.lastLoginAt) : <Absent />}
            </Detail>
            <Detail label="Two-factor">
              {account.mfaEnabled ? 'Enabled' : <Absent>Not enabled</Absent>}
            </Detail>
          </dl>

          <section className="flex flex-col gap-2">
            <h3 className="text-md font-bold text-ink">Roles</h3>
            {account.roles.length === 0 ? (
              <Alert tone="warning" title="No roles">
                This account holds no roles, so every protected request it makes is refused.
              </Alert>
            ) : (
              <div className="flex flex-wrap gap-1">
                {account.roles.map((role) => (
                  <Badge key={role.id} tone="neutral" variant="soft" size="sm">
                    {role.name}
                  </Badge>
                ))}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-md font-bold text-ink">
              Effective permissions
              {permissions.data ? (
                <span className="ml-1.5 font-normal text-muted">({permissions.data.length})</span>
              ) : null}
            </h3>
            <p className="text-xs text-muted">
              Every permission the server will accept from this account, resolved from all of its
              roles.
            </p>
            <div className="flex flex-wrap gap-1">
              {(permissions.data ?? []).map((code) => (
                <code
                  key={code}
                  className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-ink"
                >
                  {code}
                </code>
              ))}
              {permissions.data?.length === 0 ? <Absent>None</Absent> : null}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h3 className="text-md font-bold text-ink">History</h3>
            {activity.data && activity.data.length > 0 ? (
              <Timeline
                items={activity.data
                  .slice()
                  .reverse()
                  .map((entry) => ({
                    id: entry.id,
                    at: entry.at,
                    title: entry.summary,
                    description: `${entry.actionLabel} by ${entry.actorName}`,
                  }))}
              />
            ) : (
              <Absent>Nothing recorded for this account yet</Absent>
            )}
          </section>
        </div>
      ) : null}
      {linkOpen && account ? <EmployeeLinkModal account={account} onClose={() => setLinkOpen(false)} /> : null}
    </Drawer>
  );
}

/**
 * Which employee this account is (owner, 2026-10-07): a recruiter's "My leads" reads it. One
 * account per employee; the change is audited on the account's history.
 */
function EmployeeLinkModal({ account, onClose }: { account: AdminAccount; onClose: () => void }) {
  const { toast } = useToast();
  const linkable = useLinkableEmployees(true);
  const [value, setValue] = useState(account.employeeId ?? '');
  const [error, setError] = useState<string | null>(null);
  const mutation = useAdminMutation((employeeId: string | null) =>
    adminApi.setAccountEmployee(account.membershipId, employeeId),
  );
  const options = [
    { value: '', label: 'Not linked' },
    ...(account.employeeId && account.employeeName
      ? [{ value: account.employeeId, label: `${account.employeeName} · ${account.employeeNumber ?? ''}` }]
      : []),
    ...(linkable.data ?? []).map((e) => ({
      value: e.id,
      label: `${e.name} · ${e.employeeNumber} · ${e.position}`,
    })),
  ];
  const submit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync(value || null);
      toast({ title: value ? `Linked ${account.name} to the employee` : `Unlinked ${account.name}`, tone: 'success' });
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change the link');
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Linked employee · ${account.name}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={mutation.isPending} disabled={(account.employeeId ?? '') === value}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not changed">
            {error}
          </Alert>
        ) : null}
        <FormField
          label="Employee"
          description={
            linkable.isPending
              ? 'Loading…'
              : 'Employees on the workforce without an account. A recruiter linked here sees their leads under Recruiting › My leads.'
          }
        >
          <Select aria-label="Linked employee" value={value} onValueChange={setValue} options={options} />
        </FormField>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------- create

function CreateAccountModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (created: CreatedAdminAccount) => void;
}) {
  const roles = useRoles();
  const delivery = useInvitationDelivery();
  const [form, setForm] = useState({
    firstName: '',
    lastName: '',
    email: '',
    phone: '',
    roleIds: [] as string[],
  });
  const [error, setError] = useState<string | null>(null);

  const mutation = useAdminMutation(adminApi.createAccount);

  const submit = async () => {
    setError(null);
    try {
      const created = await mutation.mutateAsync({
        ...form,
        phone: form.phone || null,
        employeeId: null,
        invite: true,
      });
      onCreated(created);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the account');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="Add an account"
      description="Creates a login for this company. It cannot be used until the invitation is accepted."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={mutation.isPending}
            disabled={form.roleIds.length === 0}
            title={
              form.roleIds.length === 0
                ? 'Pick at least one role: an account without one can sign in and do nothing'
                : undefined
            }
          >
            Create account
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {delivery.data && !delivery.data.available ? (
          <Alert tone="warning" title="No invitation email will be sent">
            {delivery.data.reason}
          </Alert>
        ) : null}
        {error ? (
          <Alert tone="danger" title="Not created">
            {error}
          </Alert>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <FormField label="First name" required>
            <Input
              value={form.firstName}
              onChange={(event) => setForm({ ...form, firstName: event.target.value })}
            />
          </FormField>
          <FormField label="Last name" required>
            <Input
              value={form.lastName}
              onChange={(event) => setForm({ ...form, lastName: event.target.value })}
            />
          </FormField>
        </div>

        <FormField
          label="Email"
          required
          description="The sign-in identity. Unique across the platform."
        >
          <Input
            type="email"
            value={form.email}
            onChange={(event) => setForm({ ...form, email: event.target.value })}
          />
        </FormField>

        <FormField label="Phone">
          <Input
            value={form.phone}
            onChange={(event) => setForm({ ...form, phone: event.target.value })}
          />
        </FormField>

        <FormField
          label="Roles"
          required
          description="At least one. An account with no role signs in and is refused by every screen."
        >
          <div className="flex flex-col gap-1.5">
            {(roles.data ?? []).map((role) => (
              <Checkbox
                key={role.id}
                label={role.name}
                description={role.description ?? undefined}
                checked={form.roleIds.includes(role.id)}
                onCheckedChange={(checked) =>
                  setForm({
                    ...form,
                    roleIds: checked
                      ? [...form.roleIds, role.id]
                      : form.roleIds.filter((id) => id !== role.id),
                  })
                }
              />
            ))}
          </div>
        </FormField>
      </div>
    </Modal>
  );
}

// --------------------------------------------------------------------------------------- roles

function RolesModal({ account, onClose }: { account: AdminAccount; onClose: () => void }) {
  const roles = useRoles();
  const { toast } = useToast();
  const [selected, setSelected] = useState(account.roles.map((role) => role.id));
  const [error, setError] = useState<string | null>(null);
  const mutation = useAdminMutation((roleIds: string[]) =>
    adminApi.setAccountRoles(account.membershipId, roleIds),
  );

  const submit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync(selected);
      toast({ title: `Roles updated for ${account.name}`, tone: 'success' });
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change the roles');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Roles for ${account.name}`}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={mutation.isPending}>
            Save roles
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not changed">
            {error}
          </Alert>
        ) : null}
        <div className="flex flex-col gap-1.5">
          {(roles.data ?? []).map((role) => (
            <Checkbox
              key={role.id}
              label={role.name}
              description={role.description ?? undefined}
              checked={selected.includes(role.id)}
              onCheckedChange={(checked) =>
                setSelected(
                  checked ? [...selected, role.id] : selected.filter((id) => id !== role.id),
                )
              }
            />
          ))}
        </div>
      </div>
    </Modal>
  );
}

// -------------------------------------------------------------------------------------- status

/**
 * Gives an account a password.
 *
 * The administrator types the password and hands it to the person directly; nothing here reveals
 * an existing one, because none is stored in a readable form. Setting a password ends every
 * session that account already had.
 */
function PasswordModal({ account, onClose }: { account: AdminAccount; onClose: () => void }) {
  const { toast } = useToast();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useAdminMutation((body: { password: string }) =>
    adminApi.setAccountPassword(account.membershipId, body.password),
  );

  const submit = async () => {
    setError(null);
    if (password.length < PASSWORD_MIN_LENGTH) {
      setError(`Use at least ${PASSWORD_MIN_LENGTH} characters.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    try {
      await mutation.mutateAsync({ password });
      toast({
        title: `${account.name} can now sign in`,
        description: `Give them the password you just set, with the email ${account.email}.`,
        tone: 'success',
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not set the password');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`${account.hasPassword ? 'Replace' : 'Set'} the password for ${account.name}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={mutation.isPending}>
            {account.hasPassword ? 'Replace password' : 'Set password'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not set">
            {error}
          </Alert>
        ) : null}
        <Alert tone="info" title="How this works">
          They sign in at /login with {account.email} and the password you type here. It is stored
          as a hash and can never be read back — if they forget it, set a new one.
        </Alert>
        <FormField label="New password" description={`At least ${PASSWORD_MIN_LENGTH} characters.`}>
          <Input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </FormField>
        <FormField label="Repeat the password">
          <Input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
          />
        </FormField>
      </div>
    </Modal>
  );
}

/** The sign-in email (owner, 2026-10-12); the person signs in with the new one from now on. */
function EmailModal({ account, onClose }: { account: AdminAccount; onClose: () => void }) {
  const { toast } = useToast();
  const [email, setEmail] = useState(account.email);
  const [error, setError] = useState<string | null>(null);
  const mutation = useAdminMutation((next: string) => adminApi.changeEmail(account.membershipId, next));
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) && email.trim().toLowerCase() !== account.email.toLowerCase();
  const submit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync(email.trim());
      toast({ title: `${account.name} now signs in as ${email.trim().toLowerCase()}`, tone: 'success' });
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change the email');
    }
  };
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Change email for ${account.name}`}
      description="This is the email they sign in with."
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={mutation.isPending} disabled={!valid}>
            Change email
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not changed">
            {error}
          </Alert>
        ) : null}
        <FormField label="New email" required>
          <Input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="off" />
        </FormField>
      </div>
    </Modal>
  );
}

function StatusModal({ account, onClose }: { account: AdminAccount; onClose: () => void }) {
  const { toast } = useToast();
  const [status, setStatus] = useState(
    ASSIGNABLE_ACCOUNT_STATUSES.find((candidate) => candidate !== account.status) ?? 'suspended',
  );
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const mutation = useAdminMutation((body: unknown) =>
    adminApi.setAccountStatus(account.membershipId, body),
  );

  const submit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({ status, reason: reason || null });
      toast({ title: `${account.name} is now ${status}`, tone: 'success' });
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change the status');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Change status for ${account.name}`}
      size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={mutation.isPending}>
            Change status
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not changed">
            {error}
          </Alert>
        ) : null}
        <FormField label="New status">
          <Select
            options={ACCOUNT_STATUSES.filter((candidate) =>
              (ASSIGNABLE_ACCOUNT_STATUSES as readonly string[]).includes(candidate),
            ).map((candidate) => ({
              value: candidate,
              label: `${candidate} — ${ACCOUNT_STATUS_MEANING[candidate]}`,
              disabled: candidate === account.status,
            }))}
            value={status}
            onValueChange={(value) => setStatus(value as typeof status)}
          />
        </FormField>
        <FormField label="Reason" description="Recorded on the audit entry.">
          <Textarea rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
