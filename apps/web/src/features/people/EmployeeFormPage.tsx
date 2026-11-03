import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import {
  COMMON_POSITIONS,
  DEPARTMENT_LABELS,
  EMPLOYEE_DEPARTMENTS,
  EMPLOYMENT_TYPES,
  PAY_TYPE_LABELS,
  payTypeForDepartment,
  type CreateEmployeeRequest,
  type EmployeeDepartment,
  type EmploymentType,
} from '@neway/shared';
import {
  BackButton,
  Alert,
  Button,
  Card,
  DatePicker,
  Input,
  PageHeader,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import { ApiError } from '@/lib/api-client';

import { employmentTypeLabel } from './employee-labels';
import { useCreateEmployee, useEmployeeDirectory } from './useEmployees';

/**
 * Creating an employee.
 *
 * A full page rather than a modal, because this is the record eight other modules will hang off and
 * it deserves the room. Only what the employment relationship actually needs is asked for: no date
 * of birth, no social security number, no bank details — none of it is used by anything this system
 * does today, and collecting sensitive data that nothing reads is a liability rather than a feature.
 */

interface Section {
  title: string;
  description: string;
}

function FormSectionCard({
  title,
  description,
  children,
}: Section & { children: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="grid gap-5 xl:grid-cols-[14rem_minmax(0,1fr)] xl:gap-8">
        <div>
          <h2 className="text-md font-bold text-ink">{title}</h2>
          <p className="mt-1 text-xs text-muted">{description}</p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">{children}</div>
      </div>
    </Card>
  );
}

function Field({
  label,
  required,
  hint,
  children,
  wide,
}: {
  label: string;
  required?: boolean;
  hint?: string;
  children: React.ReactNode;
  wide?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 text-sm ${wide ? 'sm:col-span-2' : ''}`}>
      <span className="font-medium text-ink">
        {label}
        {required ? <span className="ml-0.5 text-danger-text">*</span> : null}
      </span>
      {children}
      {hint ? <span className="text-xs text-muted">{hint}</span> : null}
    </label>
  );
}

export function EmployeeFormPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const create = useCreateEmployee();
  const directory = useEmployeeDirectory();

  const [form, setForm] = useState({
    firstName: '',
    middleName: '',
    lastName: '',
    preferredName: '',
    workEmail: '',
    personalEmail: '',
    phone: '',
    secondaryPhone: '',
    department: 'dispatch' as EmployeeDepartment,
    position: '',
    managerEmployeeId: '',
    location: '',
    hireDate: new Date().toISOString().slice(0, 10),
    employmentType: 'full_time' as EmploymentType,
    shiftTime: '',
    payRate: '',
    emergencyContactName: '',
    emergencyContactPhone: '',
    emergencyContactRelationship: '',
    notes: '',
  });

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const missing =
    !form.firstName.trim() ||
    !form.lastName.trim() ||
    !form.workEmail.trim() ||
    !form.phone.trim() ||
    !form.shiftTime.trim() ||
    !form.hireDate;
  // The pay type follows the department (owner, 2026-10-26); it is shown, not chosen.
  const payType = payTypeForDepartment(form.department);

  function submit() {
    const rate = Number.parseFloat(form.payRate);
    const payload: CreateEmployeeRequest = {
      firstName: form.firstName.trim(),
      middleName: form.middleName.trim() || null,
      lastName: form.lastName.trim(),
      preferredName: form.preferredName.trim() || null,
      workEmail: form.workEmail.trim(),
      personalEmail: form.personalEmail.trim() || null,
      phone: form.phone.trim(),
      secondaryPhone: form.secondaryPhone.trim() || null,
      department: form.department,
      position: form.position.trim(),
      managerEmployeeId: form.managerEmployeeId || null,
      location: form.location.trim() || null,
      hireDate: form.hireDate,
      employmentType: form.employmentType,
      payType,
      shiftTime: form.shiftTime.trim(),
      // Null, never zero: an unrecorded rate and a rate of nothing are different claims.
      payRate: Number.isFinite(rate) && rate > 0 ? rate : null,
      timezone: 'America/Chicago',
      emergencyContactName: form.emergencyContactName.trim() || null,
      emergencyContactPhone: form.emergencyContactPhone.trim() || null,
      emergencyContactRelationship: form.emergencyContactRelationship.trim() || null,
      notes: form.notes.trim() || null,
    };

    create.mutate(payload, {
      onSuccess: (employee) => {
        toast({
          tone: 'success',
          title: `${employee.name} added as ${employee.employeeNumber}`,
          description:
            'Active, with no sign-in account and no driving profile until either is created.',
        });
        void navigate({ to: '/hr/employees/$employeeId', params: { employeeId: employee.id } });
      },
    });
  }

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Create employee"
        description="A workforce record. Their sign-in account and driving profile, if they need either, are created separately and linked to this."
        back={<BackButton fallback="/hr/employees" />}
      />

      {create.error ? (
        <Alert
          tone="danger"
          title="The employee was not created"
          description={
            create.error instanceof ApiError
              ? create.error.message
              : 'Something went wrong. Nothing was saved.'
          }
        />
      ) : null}

      <div className="flex flex-col gap-4">
        <FormSectionCard
          title="Personal information"
          description="Only what the employment relationship needs. Nothing sensitive is collected that nothing reads."
        >
          <Field label="First name" required>
            <Input value={form.firstName} onChange={(e) => set('firstName', e.target.value)} />
          </Field>
          <Field label="Last name" required>
            <Input value={form.lastName} onChange={(e) => set('lastName', e.target.value)} />
          </Field>
          <Field label="Middle name">
            <Input value={form.middleName} onChange={(e) => set('middleName', e.target.value)} />
          </Field>
          <Field label="Preferred name" hint="Used everywhere their name is shown.">
            <Input
              value={form.preferredName}
              onChange={(e) => set('preferredName', e.target.value)}
            />
          </Field>
        </FormSectionCard>

        <FormSectionCard
          title="Contact"
          description="Work contact is required; personal contact is optional and only used when work contact fails."
        >
          <Field label="Work email" required>
            <Input
              type="email"
              value={form.workEmail}
              onChange={(e) => set('workEmail', e.target.value)}
            />
          </Field>
          <Field label="Phone" required>
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Personal email">
            <Input
              type="email"
              value={form.personalEmail}
              onChange={(e) => set('personalEmail', e.target.value)}
            />
          </Field>
          <Field label="Secondary phone">
            <Input
              value={form.secondaryPhone}
              onChange={(e) => set('secondaryPhone', e.target.value)}
            />
          </Field>
        </FormSectionCard>

        <FormSectionCard
          title="Employment"
          description="What they do, where, and who they answer to. Changing any of these later opens a new row in their employment history."
        >
          <Field label="Shift time" required>
            <Input
              value={form.shiftTime}
              onChange={(e) => set('shiftTime', e.target.value)}
              placeholder="6 PM – 6 AM Eastern"
            />
          </Field>
          <Field label="Position" hint="Optional. Pick one, or type your own.">
            <Input
              list="new-employee-positions"
              value={form.position}
              onChange={(e) => set('position', e.target.value)}
            />
            <datalist id="new-employee-positions">
              {COMMON_POSITIONS.filter((p) => p !== 'Driver').map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </Field>
          <Field label="Department" required>
            <Select
              value={form.department}
              onValueChange={(value) => set('department', value as EmployeeDepartment)}
              options={EMPLOYEE_DEPARTMENTS.map((d) => ({ value: d, label: DEPARTMENT_LABELS[d] }))}
            />
          </Field>
          <Field label="Employment type" required>
            <Select
              value={form.employmentType}
              onValueChange={(value) => set('employmentType', value as EmploymentType)}
              options={EMPLOYMENT_TYPES.map((t) => ({ value: t, label: employmentTypeLabel(t) }))}
            />
          </Field>
          <Field label="Hire date" required>
            <DatePicker value={form.hireDate} onIsoChange={(iso) => set('hireDate', iso)} />
          </Field>
          <Field label="Manager" hint="Who approvals and escalations go to.">
            <Select
              value={form.managerEmployeeId}
              onValueChange={(value) => set('managerEmployeeId', value)}
              placeholder={directory.isPending ? 'Loading…' : 'No manager'}
              options={(directory.data ?? []).map((p) => ({
                value: p.id,
                label: p.name,
                description: p.position,
              }))}
            />
          </Field>
          <Field label="Location">
            <Input
              value={form.location}
              onChange={(e) => set('location', e.target.value)}
              placeholder="Naperville, IL"
            />
          </Field>
        </FormSectionCard>

        <FormSectionCard
          title="Compensation"
          description="Optional. Leave it blank if the rate is not agreed yet — blank reads as 'not recorded', which is the truth."
        >
          <Field label="Pay type" hint="Set by the department: Dispatch is Commission (KPI), every other department Fixed.">
            <Input value={PAY_TYPE_LABELS[payType]} readOnly disabled />
          </Field>
          <Field label="Rate">
            <Input
              type="number"
              min="0"
              step="0.01"
              value={form.payRate}
              onChange={(e) => set('payRate', e.target.value)}
              placeholder="0"
            />
          </Field>
          <Field label="" wide>
            <p className="text-xs text-muted">
              Drivers are not paid from here — their compensation is the pay plan on their driver
              profile, and settlements are calculated from that.
            </p>
          </Field>
        </FormSectionCard>

        <FormSectionCard
          title="Emergency contact"
          description="Who to call. Optional, and stored only for that purpose."
        >
          <Field label="Name">
            <Input
              value={form.emergencyContactName}
              onChange={(e) => set('emergencyContactName', e.target.value)}
            />
          </Field>
          <Field label="Phone">
            <Input
              value={form.emergencyContactPhone}
              onChange={(e) => set('emergencyContactPhone', e.target.value)}
            />
          </Field>
          <Field label="Relationship">
            <Input
              value={form.emergencyContactRelationship}
              onChange={(e) => set('emergencyContactRelationship', e.target.value)}
            />
          </Field>
        </FormSectionCard>

        <FormSectionCard title="Notes" description="Anything else worth recording on the file.">
          <Field label="" wide>
            <Textarea value={form.notes} onChange={(e) => set('notes', e.target.value)} rows={4} />
          </Field>
        </FormSectionCard>
      </div>

      <div className="flex justify-end gap-2">
        <Button
          variant="secondary"
          disabled={create.isPending}
          onClick={() => void navigate({ to: '/hr/employees' })}
        >
          Cancel
        </Button>
        <Button variant="primary" loading={create.isPending} disabled={missing} onClick={submit}>
          Create employee
        </Button>
      </div>
    </div>
  );
}
