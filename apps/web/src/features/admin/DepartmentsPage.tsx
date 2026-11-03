import { useState } from 'react';
import { Building2, Plus } from 'lucide-react';
import type { Department, DepartmentNode } from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  FormField,
  Input,
  Modal,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError } from '@/lib/api-client';
import { Absent, PermissionGate } from './components/AdminKit';
import {
  adminApi,
  useAdminMutation,
  useDepartmentTree,
  useDepartments,
  useHasPermission,
  usePermissionCheck,
} from './useAdmin';

export function DepartmentsPage() {
  const check = usePermissionCheck('departments.view');
  return (
    <PermissionGate check={check} permission="departments.view" what="departments">
      <DepartmentsPageContent />
    </PermissionGate>
  );
}

/**
 * Departments.
 *
 * Headcount is counted from `employees.department` — the column the workforce, reporting and
 * analytics queries all read — so this page and every report agree by construction rather than by
 * coincidence.
 *
 * The seven departments the workforce already uses are marked built-in. Their code is written into
 * 82 employee rows, so renaming the display name is safe and changing the code is a data migration;
 * the form only offers the safe one.
 */
function DepartmentsPageContent() {
  const canCreate = useHasPermission('departments.create');
  const canEdit = useHasPermission('departments.edit');

  const departments = useDepartments();
  const tree = useDepartmentTree();
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<Department | null>(null);

  const total = departments.data?.reduce((sum, dept) => sum + dept.employeeCount, 0) ?? null;
  const unassigned = departments.data?.filter((dept) => dept.employeeCount === 0).length ?? null;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Departments"
        description="The structure the workforce is organised by. Headcount comes from the employee records themselves."
        actions={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden className="size-4" />
              New department
            </Button>
          ) : null
        }
      />

      <div className="flex flex-wrap gap-2">
        <Card className="flex min-w-40 flex-col gap-0.5 px-3 py-2">
          <span className="text-xs font-medium text-muted">Departments</span>
          <span className="text-lg font-semibold tabular-nums text-ink">
            {departments.data?.length ?? '—'}
          </span>
        </Card>
        <Card className="flex min-w-40 flex-col gap-0.5 px-3 py-2">
          <span className="text-xs font-medium text-muted">People placed</span>
          <span className="text-lg font-semibold tabular-nums text-ink">{total ?? '—'}</span>
        </Card>
        <Card className="flex min-w-40 flex-col gap-0.5 px-3 py-2">
          <span className="text-xs font-medium text-muted">Empty departments</span>
          <span className="text-lg font-semibold tabular-nums text-ink">{unassigned ?? '—'}</span>
        </Card>
      </div>

      <Card className="flex flex-col gap-1 p-3">
        {tree.isLoading ? <p className="text-sm text-muted">Loading…</p> : null}
        {tree.data?.length === 0 ? <Absent>No departments yet</Absent> : null}
        {(tree.data ?? []).map((node) => (
          <DepartmentRow
            key={node.id}
            node={node}
            canEdit={canEdit}
            onEdit={(department) => setEditing(department)}
          />
        ))}
      </Card>

      {creating ? (
        <DepartmentModal
          department={null}
          departments={departments.data ?? []}
          onClose={() => setCreating(false)}
        />
      ) : null}
      {editing ? (
        <DepartmentModal
          department={editing}
          departments={departments.data ?? []}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </div>
  );
}

function DepartmentRow({
  node,
  canEdit,
  onEdit,
}: {
  node: DepartmentNode;
  canEdit: boolean;
  onEdit: (department: Department) => void;
}) {
  return (
    <>
      <div
        className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-surface-hover"
        style={{ paddingLeft: `${0.5 + node.depth * 1.25}rem` }}
      >
        <Building2 aria-hidden className="size-4 shrink-0 text-muted" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-sm font-medium text-ink">{node.name}</span>
            <code className="rounded bg-surface-sunken px-1.5 py-0.5 font-mono text-xs text-muted">
              {node.code}
            </code>
            {node.isSystem ? (
              <Badge tone="neutral" variant="outline" size="sm">
                Built in
              </Badge>
            ) : null}
            {node.status === 'inactive' ? (
              <Badge tone="warning" variant="soft" size="sm">
                Inactive
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted">
            {node.managerName ? `Managed by ${node.managerName}` : 'No manager assigned'}
          </p>
        </div>
        <span className="shrink-0 text-sm tabular-nums text-ink">
          {node.employeeCount}
          <span className="ml-1 text-xs text-muted">
            {node.employeeCount === 1 ? 'person' : 'people'}
          </span>
        </span>
        {canEdit ? (
          <Button variant="ghost" size="sm" onClick={() => onEdit(node)}>
            Edit
          </Button>
        ) : null}
      </div>
      {node.children.map((child) => (
        <DepartmentRow key={child.id} node={child} canEdit={canEdit} onEdit={onEdit} />
      ))}
    </>
  );
}

function DepartmentModal({
  department,
  departments,
  onClose,
}: {
  department: Department | null;
  departments: Department[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const employees = useEmployeeDirectory();
  const [form, setForm] = useState({
    code: department?.code ?? '',
    name: department?.name ?? '',
    description: department?.description ?? '',
    parentDepartmentId: department?.parentDepartmentId ?? '',
    managerEmployeeId: department?.managerEmployeeId ?? '',
    status: department?.status ?? 'active',
  });
  const [error, setError] = useState<string | null>(null);

  const mutation = useAdminMutation((body: Record<string, unknown>) =>
    department ? adminApi.updateDepartment(department.id, body) : adminApi.createDepartment(body),
  );

  const submit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync(
        department
          ? {
              name: form.name,
              description: form.description || null,
              parentDepartmentId: form.parentDepartmentId || null,
              managerEmployeeId: form.managerEmployeeId || null,
              status: form.status,
            }
          : {
              code: form.code,
              name: form.name,
              description: form.description || null,
              parentDepartmentId: form.parentDepartmentId || null,
              managerEmployeeId: form.managerEmployeeId || null,
            },
      );
      toast({
        title: department ? `${form.name} updated` : `${form.name} created`,
        tone: 'success',
      });
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the department');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={department ? `Edit ${department.name}` : 'New department'}
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} loading={mutation.isPending}>
            {department ? 'Save changes' : 'Create department'}
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

        {department?.isSystem ? (
          <Alert tone="info" title="Built-in department">
            The code <code className="font-mono text-xs">{department.code}</code> is stored on every
            employee in this department and is read by the workforce, reporting and analytics
            queries, so it cannot be changed here. The name can.
          </Alert>
        ) : null}

        {department ? null : (
          <FormField
            label="Code"
            required
            description="Lowercase, permanent. Employees are stored against it."
          >
            <Input
              value={form.code}
              onChange={(event) => setForm({ ...form, code: event.target.value })}
              placeholder="operations"
            />
          </FormField>
        )}

        <FormField label="Name" required>
          <Input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
          />
        </FormField>

        <FormField label="Description">
          <Textarea
            rows={2}
            value={form.description}
            onChange={(event) => setForm({ ...form, description: event.target.value })}
          />
        </FormField>

        <FormField label="Reports to">
          <Select
            options={[
              { value: '', label: 'Top level' },
              ...departments
                .filter((candidate) => candidate.id !== department?.id)
                .map((candidate) => ({ value: candidate.id, label: candidate.name })),
            ]}
            value={form.parentDepartmentId}
            onValueChange={(value) => setForm({ ...form, parentDepartmentId: value })}
          />
        </FormField>

        <FormField label="Manager">
          <Select
            options={[
              { value: '', label: 'No manager' },
              ...(employees.data ?? []).map((employee) => ({
                value: employee.id,
                label: `${employee.firstName} ${employee.lastName} · ${employee.position}`,
              })),
            ]}
            value={form.managerEmployeeId}
            onValueChange={(value) => setForm({ ...form, managerEmployeeId: value })}
          />
        </FormField>

        {department ? (
          <FormField
            label="Status"
            description="A department with people in it cannot be deactivated."
          >
            <Select
              options={[
                { value: 'active', label: 'Active' },
                {
                  value: 'inactive',
                  label: 'Inactive',
                  disabled: department.employeeCount > 0,
                },
              ]}
              value={form.status}
              onValueChange={(value) => setForm({ ...form, status: value as Department['status'] })}
            />
          </FormField>
        ) : null}
      </div>
    </Modal>
  );
}
