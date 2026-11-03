import { useMemo, useState } from 'react';
import { Archive, Copy, Pencil, Plus, ShieldCheck } from 'lucide-react';
import { withImpliedPermissions, type PermissionGroup, type Role } from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  Checkbox,
  ConfirmDialog,
  FormField,
  Input,
  Modal,
  PageHeader,
  Textarea,
  useToast,
} from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { Absent, PermissionGate } from './components/AdminKit';
import {
  adminApi,
  useAdminMutation,
  useHasPermission,
  usePermissionCheck,
  usePermissionMatrix,
  useRoles,
} from './useAdmin';

export function RolesPage() {
  const check = usePermissionCheck('roles.view');
  return (
    <PermissionGate check={check} permission="roles.view" what="roles">
      <RolesPageContent />
    </PermissionGate>
  );
}

/**
 * Roles and permissions.
 *
 * The matrix is served by the API from the shared registry, never assembled here. That is what
 * makes the checkboxes honest: every code on this screen is one the backend actually enforces, and
 * a permission the backend does not check cannot appear for someone to switch on and believe in.
 *
 * Every role opens read-only and changes through "Edit". Editing a built-in role saves this
 * company's own version of it (the server moves the company's accounts onto it); other companies
 * keep the shipped one. The server refuses a change that would leave nobody able to administer.
 */
function RolesPageContent() {
  const canCreate = useHasPermission('roles.create');
  const canEdit = useHasPermission('roles.edit');
  const canArchive = useHasPermission('roles.archive');

  const roles = useRoles();
  const matrix = usePermissionMatrix();
  const [picked, setPicked] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ copyFrom: Role | null } | null>(null);
  const [archiving, setArchiving] = useState<Role | null>(null);

  // Derived rather than synced through an effect: the first role is the selection until somebody
  // picks another, which is one rule instead of two pieces of state that can disagree.
  const selected = roles.data?.find((role) => role.id === picked) ?? roles.data?.[0] ?? null;
  const selectedId = selected?.id ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Roles & permissions"
        description="What each role may do. Every permission here is checked by the server before it acts."
        actions={
          canCreate ? (
            <Button onClick={() => setCreating({ copyFrom: null })}>
              <Plus aria-hidden className="size-4" />
              New role
            </Button>
          ) : null
        }
      />

      <div className="grid gap-4 lg:grid-cols-[18rem_1fr]">
        <Card className="flex flex-col gap-1 p-2">
          {roles.isLoading ? <p className="p-3 text-sm text-muted">Loading roles…</p> : null}
          {(roles.data ?? []).map((role) => (
            <button
              key={role.id}
              type="button"
              onClick={() => setPicked(role.id)}
              className={`flex flex-col gap-0.5 rounded-md px-3 py-2 text-left transition-colors ${
                role.id === selectedId ? 'bg-primary-soft' : 'hover:bg-surface-hover'
              }`}
            >
              <span className="flex items-center gap-1.5 text-sm font-medium text-ink">
                {role.name}
                {role.isSystem ? (
                  <Badge tone="neutral" variant="outline" size="sm">
                    Built in
                  </Badge>
                ) : null}
              </span>
              <span className="text-xs text-muted">
                {role.permissions.length} permissions · {role.accountCount}{' '}
                {role.accountCount === 1 ? 'account' : 'accounts'}
              </span>
            </button>
          ))}
        </Card>

        {selected ? (
          <RoleDetail
            // Keyed by the saved permission set: after a save the draft is rebuilt from the
            // server's answer, and switching roles starts clean, without an effect to sync it.
            key={`${selected.id}:${selected.permissions.join(',')}`}
            role={selected}
            matrix={matrix.data ?? []}
            canEdit={canEdit}
            canArchive={canArchive}
            canCreate={canCreate}
            onDuplicate={() => setCreating({ copyFrom: selected })}
            onArchive={() => setArchiving(selected)}
            onSaved={(role) => setPicked(role.id)}
          />
        ) : (
          <Card className="p-6">
            <Absent>Select a role</Absent>
          </Card>
        )}
      </div>

      {creating ? (
        <CreateRoleModal
          copyFrom={creating.copyFrom}
          matrix={matrix.data ?? []}
          onClose={() => setCreating(null)}
          onCreated={(role) => {
            setCreating(null);
            setPicked(role.id);
          }}
        />
      ) : null}

      {archiving ? <ArchiveRoleDialog role={archiving} onClose={() => setArchiving(null)} /> : null}
    </div>
  );
}

function RoleDetail({
  role,
  matrix,
  canEdit,
  canArchive,
  canCreate,
  onDuplicate,
  onArchive,
  onSaved,
}: {
  role: Role;
  matrix: PermissionGroup[];
  canEdit: boolean;
  canArchive: boolean;
  canCreate: boolean;
  onDuplicate: () => void;
  onArchive: () => void;
  onSaved: (role: Role) => void;
}) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string[]>(role.permissions);
  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const mutation = useAdminMutation(
    (body: { name: string; description: string | null; permissions: string[] }) =>
      adminApi.updateRole(role.id, body),
  );

  const editable = canEdit && editing;
  const dirty = useMemo(
    () =>
      name.trim() !== role.name ||
      (description.trim() || null) !== (role.description ?? null) ||
      draft.length !== role.permissions.length ||
      draft.some((code) => !role.permissions.includes(code)),
    [draft, name, description, role],
  );

  const cancel = () => {
    setDraft(role.permissions);
    setName(role.name);
    setDescription(role.description ?? '');
    setError(null);
    setEditing(false);
  };

  const toggle = (code: string, checked: boolean) => {
    setDraft((current) => {
      const next = checked
        ? withImpliedPermissions([...current, code])
        : current.filter((existing) => existing !== code);
      return next;
    });
  };

  const save = async () => {
    setError(null);
    try {
      const saved = await mutation.mutateAsync({
        name: name.trim(),
        description: description.trim() || null,
        permissions: draft,
      });
      toast({ title: `${saved.name} saved`, tone: 'success' });
      setEditing(false);
      onSaved(saved);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the role');
    }
  };

  return (
    <Card className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
            <ShieldCheck aria-hidden className="size-4 text-muted" />
            {role.name}
          </h2>
          <p className="mt-0.5 text-sm text-muted">{role.description ?? 'No description.'}</p>
        </div>
        <div className="flex gap-2">
          {canEdit && !editing ? (
            <Button onClick={() => setEditing(true)}>
              <Pencil aria-hidden className="size-4" />
              Edit
            </Button>
          ) : null}
          {canCreate && !editing ? (
            <Button variant="secondary" onClick={onDuplicate}>
              <Copy aria-hidden className="size-4" />
              Duplicate
            </Button>
          ) : null}
          {canArchive && !role.isSystem && !editing ? (
            <Button variant="outline" onClick={onArchive}>
              <Archive aria-hidden className="size-4" />
              Archive
            </Button>
          ) : null}
        </div>
      </header>

      {role.isSystem && editing ? (
        <Alert tone="info" title="Built-in role">
          Saving makes this company's own version of {role.name}. Its accounts move onto it with
          your changes; other companies keep the original.
        </Alert>
      ) : null}

      {editing ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Name" required>
            <Input aria-label="Role name" value={name} onChange={(event) => setName(event.target.value)} />
          </FormField>
          <FormField label="Description">
            <Input
              aria-label="Role description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </FormField>
        </div>
      ) : null}

      {error ? (
        <Alert tone="danger" title="Not saved">
          {error}
        </Alert>
      ) : null}

      <p className="text-sm text-muted">
        Held by {role.accountCount} {role.accountCount === 1 ? 'account' : 'accounts'} in this
        company. Ticking an action automatically grants the matching “view”, because a role that can
        edit something it cannot open does not work.
      </p>

      <div className="flex flex-col gap-4">
        {matrix.map((group) => (
          <section key={`${group.module}:${group.group}`} className="flex flex-col gap-1.5">
            <h3 className="eyebrow">
              {group.module} · {group.group}
            </h3>
            <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
              {group.permissions.map((permission) => (
                <Checkbox
                  key={permission.code}
                  label={permission.description}
                  description={permission.code}
                  checked={draft.includes(permission.code)}
                  disabled={!editable}
                  onCheckedChange={(checked) => toggle(permission.code, checked === true)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>

      {editable ? (
        <div className="flex items-center justify-end gap-2 border-t border-line pt-3">
          <Button variant="ghost" onClick={cancel} disabled={mutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={!dirty || name.trim().length < 2}
            loading={mutation.isPending}
          >
            Save changes
          </Button>
        </div>
      ) : null}
    </Card>
  );
}

function CreateRoleModal({
  copyFrom,
  matrix,
  onClose,
  onCreated,
}: {
  copyFrom: Role | null;
  matrix: PermissionGroup[];
  onClose: () => void;
  onCreated: (role: Role) => void;
}) {
  const [name, setName] = useState(copyFrom ? `${copyFrom.name} (copy)` : '');
  const [description, setDescription] = useState(copyFrom?.description ?? '');
  const [permissions, setPermissions] = useState<string[]>(copyFrom?.permissions ?? []);
  const [error, setError] = useState<string | null>(null);
  const mutation = useAdminMutation(adminApi.createRole);

  const submit = async () => {
    setError(null);
    try {
      const created = await mutation.mutateAsync({
        name,
        description: description || null,
        permissions,
        copyFromRoleId: null,
      });
      onCreated(created);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the role');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={copyFrom ? `Duplicate ${copyFrom.name}` : 'New role'}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={mutation.isPending}>
            Create role
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
        <FormField label="Name" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </FormField>
        <FormField label="Description">
          <Textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FormField>
        <div className="flex max-h-96 flex-col gap-4 overflow-y-auto rounded-md border border-line p-3">
          {matrix.map((group) => (
            <section key={`${group.module}:${group.group}`} className="flex flex-col gap-1.5">
              <h3 className="eyebrow">
                {group.module} · {group.group}
              </h3>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {group.permissions.map((permission) => (
                  <Checkbox
                    key={permission.code}
                    label={permission.description}
                    description={permission.code}
                    checked={permissions.includes(permission.code)}
                    onCheckedChange={(checked) =>
                      setPermissions((current) =>
                        checked === true
                          ? withImpliedPermissions([...current, permission.code])
                          : current.filter((code) => code !== permission.code),
                      )
                    }
                  />
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function ArchiveRoleDialog({ role, onClose }: { role: Role; onClose: () => void }) {
  const { toast } = useToast();
  const [error, setError] = useState<string | null>(null);
  const mutation = useAdminMutation(() => adminApi.archiveRole(role.id));

  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Archive ${role.name}?`}
      description={
        role.accountCount > 0
          ? `${role.accountCount} account${role.accountCount === 1 ? '' : 's'} still hold this role. Move them to another role first — archiving it would silently remove their access.`
          : 'It stops being assignable. Nothing that referenced it is deleted.'
      }
      confirmLabel="Archive role"
      tone="danger"
      hideConfirm={role.accountCount > 0}
      onConfirm={async () => {
        setError(null);
        try {
          await mutation.mutateAsync(undefined);
          toast({ title: `${role.name} archived`, tone: 'success' });
          onClose();
        } catch (caught) {
          setError(caught instanceof ApiError ? caught.message : 'Could not archive the role');
          throw caught;
        }
      }}
    >
      {error ? (
        <Alert tone="danger" title="Not archived">
          {error}
        </Alert>
      ) : null}
    </ConfirmDialog>
  );
}
