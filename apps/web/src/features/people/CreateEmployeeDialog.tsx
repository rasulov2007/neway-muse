import { useState } from 'react';
import {
  COMMON_POSITIONS,
  DEPARTMENT_LABELS,
  EMPLOYEE_DEPARTMENTS,
  PAY_TYPE_LABELS,
  payTypeForDepartment,
  type CreateEmployeeRequest,
  type Dispatcher,
  type EmployeeDepartment,
  type EmployeeRecord,
} from '@neway/shared';
import { Button, DatePicker, FormField, Input, Modal, Select, useToast } from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { useCreateEmployee } from './useEmployees';

const EMPLOYMENT_OPTIONS = [
  { value: 'full_time', label: 'Full-Time' },
  { value: 'part_time', label: 'Part-Time' },
  { value: 'contractor', label: 'Contractor' },
  { value: 'temporary', label: 'Temporary' },
] as const;


/** What the overlay is opened as: a dispatcher (department and title fixed) or any employee. */
export type CreateEmployeePreset = 'employee' | 'dispatcher';

/**
 * Create employee / Create dispatcher, as an overlay (owner's brief, 2026-09-21): identity, role,
 * compensation and contact, over whatever page opened it. Nothing navigates away: on success the
 * form closes, the lists refresh and the caller gets the record - a dispatcher picker that opened
 * it selects the new person. A dispatcher is an employee in the Dispatcher position, so both
 * presets write the one record the Employees page shows and every dispatcher picker reads.
 */
export function CreateEmployeeDialog({
  open,
  onOpenChange,
  onCreated,
  initialName = '',
  preset = 'employee',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (dispatcher: Dispatcher, employee: EmployeeRecord) => void;
  /** What was typed into the picker that opened this, if anything. */
  initialName?: string;
  preset?: CreateEmployeePreset;
}) {
  if (!open) return null;
  return (
    <EmployeeForm
      key={`${preset}:${initialName}`}
      preset={preset}
      initialName={initialName}
      onOpenChange={onOpenChange}
      onCreated={onCreated}
    />
  );
}

/** Kept for the pickers: the dispatcher preset of the same overlay. */
export function CreateDispatcherDialog(
  props: Omit<Parameters<typeof CreateEmployeeDialog>[0], 'preset'>,
) {
  return <CreateEmployeeDialog {...props} preset="dispatcher" />;
}

function EmployeeForm({
  preset,
  initialName,
  onOpenChange,
  onCreated,
}: {
  preset: CreateEmployeePreset;
  initialName: string;
  onOpenChange: (open: boolean) => void;
  onCreated?: (dispatcher: Dispatcher, employee: EmployeeRecord) => void;
}) {
  const dispatcher = preset === 'dispatcher';
  const [department, setDepartment] = useState<EmployeeDepartment>('dispatch');
  const { toast } = useToast();
  const create = useCreateEmployee();
  const [fullName, setFullName] = useState(initialName);
  const [nickname, setNickname] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState('');
  const [passport, setPassport] = useState('');
  const [address, setAddress] = useState('');
  const [title, setTitle] = useState(dispatcher ? 'Dispatcher' : '');
  const [employmentType, setEmploymentType] =
    useState<CreateEmployeeRequest['employmentType']>('full_time');
  const [location, setLocation] = useState('');
  const [shift, setShift] = useState('');
  const [hireDate, setHireDate] = useState(companyToday());
  const [base, setBase] = useState('');
  const [phone, setPhone] = useState('');
  const [secondaryPhone, setSecondaryPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The pay type follows the department and cannot be changed (owner, 2026-10-26): Dispatch is
  // Commission (KPI), every other department Fixed. The server enforces the same rule.
  const effectiveDepartment: EmployeeDepartment = dispatcher ? 'dispatch' : department;
  const payType = payTypeForDepartment(effectiveDepartment);

  const [firstName, ...rest] = fullName.trim().split(/\s+/);
  const lastName = rest.join(' ');
  const valid =
    Boolean(firstName) &&
    Boolean(lastName) &&
    Boolean(shift.trim()) &&
    phone.trim().length >= 7 &&
    /\S+@\S+\.\S+/.test(email);

  const save = () => {
    setError(null);
    const rate = Number(base.replace(/[^0-9.]/g, ''));
    create.mutate(
      {
        firstName: firstName ?? '',
        middleName: null,
        lastName,
        preferredName: nickname.trim() || null,
        workEmail: email.trim(),
        personalEmail: null,
        phone: phone.trim(),
        secondaryPhone: secondaryPhone.trim() || null,
        department: effectiveDepartment,
        position: title.trim(),
        managerEmployeeId: null,
        location: location.trim() || null,
        hireDate,
        employmentType,
        payType,
        payRate: rate > 0 ? rate : null,
        timezone: 'America/Chicago',
        emergencyContactName: null,
        emergencyContactPhone: null,
        emergencyContactRelationship: null,
        notes: null,
        // Their own columns since 2026-10-26; date of birth and ID are masked for most readers.
        dateOfBirth: dateOfBirth || null,
        idNumber: passport.trim() || null,
        homeAddress: address.trim() || null,
        shiftTime: shift.trim(),
      },
      {
        onSuccess: (employee) => {
          toast({
            tone: 'success',
            title: employee.position
              ? `${employee.name} added as ${employee.position}`
              : `${employee.name} added`,
            description: dispatcher
              ? 'Available on every dispatcher picker now.'
              : 'On the Employees list now.',
          });
          onCreated?.(
            {
              id: employee.id,
              employeeNumber: employee.employeeNumber,
              name: employee.name,
              status: employee.status,
              active: employee.status === 'active',
              position: employee.position,
            },
            employee,
          );
          onOpenChange(false);
        },
        onError: (e: unknown) =>
          setError(e instanceof Error ? e.message : 'The dispatcher could not be created.'),
      },
    );
  };

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      size="lg"
      title={dispatcher ? 'Create dispatcher' : 'Create employee'}
      description={dispatcher ? 'Add a dispatcher to your staff.' : 'Add a person to your staff.'}
      footer={
        <>
          <span className="mr-auto text-xs text-muted">
            <span aria-hidden className="text-nw-urgent-text">
              *
            </span>{' '}
            Required fields
          </span>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button loading={create.isPending} disabled={!valid} onClick={save}>
            {dispatcher ? 'Create dispatcher' : 'Create employee'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        <Section title="Identity">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Full name" required description="First and last name.">
              <Input
                aria-label="Full name"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                autoFocus
              />
            </FormField>
            <FormField label="Nickname">
              <Input value={nickname} onChange={(e) => setNickname(e.target.value)} />
            </FormField>
            <FormField label="Date of birth">
              <DatePicker value={dateOfBirth} onIsoChange={(iso) => setDateOfBirth(iso ?? '')} />
            </FormField>
            <FormField label="Passport / ID number">
              <Input value={passport} onChange={(e) => setPassport(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Home address">
            <Input value={address} onChange={(e) => setAddress(e.target.value)} />
          </FormField>
        </Section>

        <Section title="Role">
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField label="Department" required>
              {dispatcher ? (
                <Input value={DEPARTMENT_LABELS.dispatch} readOnly />
              ) : (
                <Select
                  aria-label="Department"
                  options={EMPLOYEE_DEPARTMENTS.map((d) => ({
                    value: d,
                    label: DEPARTMENT_LABELS[d],
                  }))}
                  value={department}
                  onValueChange={(v) => setDepartment(v as EmployeeDepartment)}
                />
              )}
            </FormField>
            <FormField
              label="Title"
              description={dispatcher ? undefined : 'Pick one, or type your own.'}
            >
              <Input
                aria-label="Title"
                list="employee-titles"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={dispatcher ? 'Dispatcher' : 'Safety Manager'}
              />
              <datalist id="employee-titles">
                {COMMON_POSITIONS.filter((p) => p !== 'Driver').map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </FormField>
            <FormField label="Status">
              <Input value="Active" readOnly />
            </FormField>
            <FormField label="Employment type">
              <Select
                aria-label="Employment type"
                options={[...EMPLOYMENT_OPTIONS]}
                value={employmentType}
                onValueChange={(v) =>
                  setEmploymentType(v as CreateEmployeeRequest['employmentType'])
                }
              />
            </FormField>
            <FormField label="Location">
              <Input
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="USA"
              />
            </FormField>
            <FormField label="Shift time" required>
              <Input
                aria-label="Shift time"
                value={shift}
                onChange={(e) => setShift(e.target.value)}
                placeholder="6 PM – 6 AM Eastern"
              />
            </FormField>
            <FormField label="Hire date" required>
              <DatePicker value={hireDate} onIsoChange={(iso) => setHireDate(iso ?? '')} />
            </FormField>
          </div>
        </Section>

        <Section title="Compensation">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField
              label="Pay type"
              description={
                payType === 'commission'
                  ? 'Set by the department: Dispatch is paid on the KPI pay plan.'
                  : 'Set by the department: every department outside Dispatch is Fixed.'
              }
            >
              <Input aria-label="Pay type" value={PAY_TYPE_LABELS[payType]} readOnly disabled />
            </FormField>
            <FormField label="Fixed base ($/week)">
              <Input
                inputMode="decimal"
                value={base}
                onChange={(e) => setBase(e.target.value)}
                placeholder="0"
              />
            </FormField>
          </div>
        </Section>

        <Section title="Contact">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Primary phone" required>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </FormField>
            <FormField label="Secondary phone (emergency)">
              <Input value={secondaryPhone} onChange={(e) => setSecondaryPhone(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Email" required>
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </FormField>
        </Section>
      </div>
    </Modal>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-[11px] font-bold tracking-[.08em] text-nw-text-2 uppercase">{title}</h3>
      {children}
    </section>
  );
}
