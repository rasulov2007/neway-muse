import { useState } from 'react';
import {
  COMMON_POSITIONS,
  DEPARTMENT_LABELS,
  EMPLOYEE_DEPARTMENTS,
  PAY_TYPE_LABELS,
  payTypeForDepartment,
  statusChangeNeedsReason,
  type EmployeeDepartment,
  type EmployeeRecord,
  type EmployeeStatus,
} from '@neway/shared';
import {
  Alert,
  Button,
  DatePicker,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import { ApiError } from '@/lib/api-client';
import {
  useChangeEmployeeStatus,
  useEmployeeDirectory,
  useReassignEmployee,
  useSetCompensation,
} from '../useEmployees';

/** Turns a server problem into the sentence it wrote, rather than a generic failure. */
function messageFor(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof Error ? error.message : 'That could not be saved.';
}

const STATUS_COPY: Record<EmployeeStatus, { title: string; body: string; confirm: string }> = {
  active: {
    title: 'Activate',
    body: 'They return to the working roster and appear in assignment lists again.',
    confirm: 'Activate',
  },
  on_leave: {
    title: 'Put on leave',
    body: 'They stay employed and keep their assignments; the roster shows they are away.',
    confirm: 'Put on leave',
  },
  suspended: {
    title: 'Deactivate',
    body: 'They stay employed but are treated as not working. Their history is untouched.',
    confirm: 'Deactivate',
  },
  terminated: {
    title: 'Terminate',
    body: 'Employment ends. Nothing is deleted — their loads, settlements, payroll and safety records all remain.',
    confirm: 'Terminate',
  },
  archived: {
    title: 'Archive',
    body: 'They leave the working lists. Their record and its history stay on file permanently.',
    confirm: 'Archive',
  },
};

export function ChangeStatusModal({
  employee,
  to,
  reports,
  onClose,
}: {
  employee: EmployeeRecord;
  to: EmployeeStatus;
  reports: EmployeeRecord[];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const mutation = useChangeEmployeeStatus(employee.id);
  const [reason, setReason] = useState('');
  const copy = STATUS_COPY[to];
  const needsReason = statusChangeNeedsReason(to);
  const blocked = (to === 'terminated' || to === 'archived') && reports.length > 0;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`${copy.title} ${employee.name}?`}
      description={copy.body}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={to === 'terminated' ? 'danger' : 'primary'}
            loading={mutation.isPending}
            disabled={blocked || (needsReason && reason.trim().length === 0)}
            onClick={() =>
              mutation.mutate(
                { status: to, reason: reason.trim() || null },
                {
                  onSuccess: (saved) => {
                    toast({
                      tone: 'success',
                      title: `${saved.name} is now ${saved.status.replace(/_/g, ' ')}`,
                    });
                    onClose();
                  },
                },
              )
            }
          >
            {copy.confirm}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {blocked ? (
          <Alert
            tone="danger"
            title={`${reports.length} ${reports.length === 1 ? 'person reports' : 'people report'} to ${employee.name}`}
            description={`Reassign ${reports.map((r) => r.name).join(', ')} to another manager first. Leaving them without one is not something this will do quietly.`}
          />
        ) : null}
        {mutation.error ? (
          <Alert tone="danger" title="That was refused" description={messageFor(mutation.error)} />
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">
            Reason {needsReason ? <span className="text-danger-text">*</span> : '(optional)'}
          </span>
          <Textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            placeholder={
              to === 'terminated'
                ? 'Resigned, end of contract, dismissal…'
                : 'Why this is happening'
            }
          />
          <span className="text-xs text-muted">
            This is written to the audit trail with your name and the time.
          </span>
        </label>
      </div>
    </Modal>
  );
}

export function ReassignModal({
  employee,
  onClose,
}: {
  employee: EmployeeRecord;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const mutation = useReassignEmployee(employee.id);
  const directory = useEmployeeDirectory();
  const [position, setPosition] = useState(employee.position);
  const [department, setDepartment] = useState<EmployeeDepartment>(employee.department);
  const [managerId, setManagerId] = useState(employee.managerEmployeeId ?? '');
  const [location, setLocation] = useState(employee.location ?? '');
  const [reason, setReason] = useState('');

  const changed =
    position !== employee.position ||
    department !== employee.department ||
    managerId !== (employee.managerEmployeeId ?? '') ||
    location !== (employee.location ?? '');

  const managers = (directory.data ?? []).filter((p) => p.id !== employee.id);

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Change ${employee.name}'s role`}
      description="The previous appointment is kept. This opens a new row in their employment history rather than overwriting the last one."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={mutation.isPending}
            disabled={!changed}
            onClick={() =>
              mutation.mutate(
                {
                  position,
                  department,
                  managerEmployeeId: managerId || null,
                  location: location || null,
                  reason: reason.trim() || null,
                },
                {
                  onSuccess: (saved) => {
                    toast({ tone: 'success', title: `${saved.name} is now ${saved.position}` });
                    onClose();
                  },
                },
              )
            }
          >
            Save change
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {mutation.error ? (
          <Alert tone="danger" title="That was refused" description={messageFor(mutation.error)} />
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Position</span>
          <Input
            list="employee-positions"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          />
          <datalist id="employee-positions">
            {COMMON_POSITIONS.map((p) => (
              <option key={p} value={p} />
            ))}
          </datalist>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Department</span>
          <Select
            value={department}
            onValueChange={(value) => setDepartment(value as EmployeeDepartment)}
            options={EMPLOYEE_DEPARTMENTS.map((d) => ({ value: d, label: DEPARTMENT_LABELS[d] }))}
          />
          {department !== employee.department &&
          employee.position !== 'Driver' &&
          payTypeForDepartment(department) !== payTypeForDepartment(employee.department) ? (
            <span className="text-xs text-muted">
              Pay type becomes {PAY_TYPE_LABELS[payTypeForDepartment(department)]}: it follows the
              department.
            </span>
          ) : null}
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Manager</span>
          <Select
            value={managerId}
            onValueChange={setManagerId}
            placeholder={directory.isPending ? 'Loading…' : 'No manager'}
            options={managers.map((p) => ({
              value: p.id,
              label: p.name,
              description: p.position,
            }))}
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Location</span>
          <Input value={location} onChange={(e) => setLocation(e.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Reason (optional)</span>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Promotion, restructure, transfer…"
          />
        </label>
      </div>
    </Modal>
  );
}

export function SetCompensationModal({
  employee,
  onClose,
}: {
  employee: EmployeeRecord;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const mutation = useSetCompensation(employee.id);
  // The pay type follows the department (owner, 2026-10-26); only the amount is chosen here.
  const payType = payTypeForDepartment(employee.department);
  const [rate, setRate] = useState(employee.payRate === null ? '' : String(employee.payRate));
  const [effectiveFrom, setEffectiveFrom] = useState(new Date().toISOString().slice(0, 10));
  const [reason, setReason] = useState('');

  const parsed = Number.parseFloat(rate);
  const valid = Number.isFinite(parsed) && parsed > 0;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      title={`Set ${employee.name}'s compensation`}
      description="The previous rate is kept with its effective date, so what somebody was paid last year stays answerable."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={mutation.isPending}
            disabled={!valid}
            onClick={() =>
              mutation.mutate(
                { payType, payRate: parsed, effectiveFrom, reason: reason.trim() || null },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Compensation recorded' });
                    onClose();
                  },
                },
              )
            }
          >
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {mutation.error ? (
          <Alert tone="danger" title="That was refused" description={messageFor(mutation.error)} />
        ) : null}
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Pay type</span>
          <Input value={PAY_TYPE_LABELS[payType]} readOnly disabled />
          <span className="text-xs text-muted">Set by the {DEPARTMENT_LABELS[employee.department]} department.</span>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Rate</span>
          <Input
            type="number"
            min="0"
            step="0.01"
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            placeholder="0"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Effective from</span>
          <DatePicker value={effectiveFrom} onIsoChange={setEffectiveFrom} />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="font-medium text-ink">Reason (optional)</span>
          <Input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Annual review, promotion…"
          />
        </label>
        <p className="text-xs text-muted">
          Payroll remains the source of truth for what is actually paid; this records the agreed
          rate.
        </p>
      </div>
    </Modal>
  );
}
