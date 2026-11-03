import { describe, expect, it } from 'vitest';
import { employeeAttention, type AttentionContext } from './attention.js';
import {
  CreateEmployeeSchema,
  EMPLOYEE_STATUSES,
  EmployeeQuerySchema,
  ReassignEmployeeSchema,
  employeeTransitions,
  statusChangeNeedsReason,
  type EmployeeRecord,
} from './employee.js';

const base: EmployeeRecord = {
  id: 'emp_0001',
  employeeNumber: 'EMP-1024',
  firstName: 'John',
  middleName: null,
  lastName: 'Smith',
  preferredName: null,
  name: 'John Smith',
  workEmail: 'john.smith@northwind.example',
  personalEmail: null,
  phone: '+16305550100',
  secondaryPhone: null,
  department: 'dispatch',
  position: 'Dispatcher',
  managerEmployeeId: 'emp_0002',
  managerName: 'Sarah Chen',
  location: 'Naperville, IL',
  hireDate: '2024-03-01',
  terminationDate: null,
  status: 'active',
  employmentType: 'full_time',
  payType: 'salary',
  payRate: 62_000,
  timezone: 'America/Chicago',
  userId: 'usr_002',
  driverId: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  emergencyContactRelationship: null,
  notes: null,
  createdAt: '2024-03-01T00:00:00.000Z',
  updatedAt: '2024-03-01T00:00:00.000Z',
};

const quiet: AttentionContext = {
  hasDriverProfile: false,
  payrollConsulted: true,
  payslipCount: 3,
  directReports: 0,
};

describe('employee lifecycle', () => {
  it('never offers a transition that destroys the record', () => {
    for (const status of EMPLOYEE_STATUSES) {
      expect(employeeTransitions(status)).not.toContain('deleted');
    }
  });

  it('lets a terminated employee be archived or rehired, and nothing else', () => {
    expect([...employeeTransitions('terminated')].sort()).toEqual(['active', 'archived']);
  });

  it('demands a reason for the two changes somebody may later have to defend', () => {
    expect(statusChangeNeedsReason('terminated')).toBe(true);
    expect(statusChangeNeedsReason('suspended')).toBe(true);
    expect(statusChangeNeedsReason('on_leave')).toBe(false);
  });
});

describe('employee validation', () => {
  it('refuses a reassignment that changes nothing', () => {
    expect(ReassignEmployeeSchema.safeParse({ reason: 'tidying up' }).success).toBe(false);
    expect(ReassignEmployeeSchema.safeParse({ position: 'Updater' }).success).toBe(true);
  });

  it('treats an absent optional string as absent rather than as an empty value', () => {
    const parsed = CreateEmployeeSchema.parse({
      firstName: 'Ada',
      lastName: 'Lovelace',
      workEmail: 'ada@northwind.example',
      phone: '+16305550100',
      department: 'accounting',
      position: 'Accountant',
      hireDate: '2026-09-01',
      employmentType: 'full_time',
    });
    expect(parsed.middleName).toBeNull();
    expect(parsed.payRate).toBeNull();
    expect(parsed.managerEmployeeId).toBeNull();
  });

  it('defaults the list to working employees and to a page the server can serve', () => {
    const q = EmployeeQuerySchema.parse({});
    expect(q.includeInactive).toBe(false);
    expect(q.page).toBe(1);
    expect(q.pageSize).toBeLessThanOrEqual(200);
  });
});

describe('what needs attention', () => {
  it('says nothing when there is nothing to say', () => {
    expect(employeeAttention(base, quiet).items).toEqual([]);
  });

  it('does not ask a driver for a pay rate that lives on their driving profile', () => {
    const driver: EmployeeRecord = {
      ...base,
      position: 'Driver',
      payType: null,
      payRate: null,
      driverId: 'drv_2031',
    };
    const result = employeeAttention(driver, {
      ...quiet,
      hasDriverProfile: true,
      blockingRequirements: 0,
    });
    expect(result.items.map((i) => i.key)).not.toContain('no_compensation');
  });

  it('asks a staff member for one, because payroll cannot pay without it', () => {
    const result = employeeAttention({ ...base, payType: null, payRate: null }, quiet);
    expect(result.items.map((i) => i.key)).toContain('no_compensation');
  });

  it('declares a check it could not run instead of passing it', () => {
    const result = employeeAttention(
      { ...base, driverId: 'drv_2031' },
      { hasDriverProfile: true, payrollConsulted: false, directReports: 0 },
    );
    expect(result.unavailable.map((u) => u.key)).toEqual(['driver_compliance', 'payroll']);
    // Not knowing is not the same as being fine, and it is never reported as a finding.
    expect(result.items.map((i) => i.key)).not.toContain('driver_blocked');
  });

  it('raises a terminated driver who still holds a truck as critical', () => {
    const result = employeeAttention(
      { ...base, status: 'terminated', terminationDate: '2026-09-01', driverId: 'drv_2031' },
      { ...quiet, hasDriverProfile: true, blockingRequirements: 0, driverHoldsTruck: true },
    );
    const item = result.items.find((i) => i.key === 'terminated_holds_truck');
    expect(item?.severity).toBe('critical');
  });

  it('will not let a manager leave with their reports orphaned', () => {
    const result = employeeAttention(
      { ...base, status: 'terminated', terminationDate: '2026-09-01' },
      { ...quiet, directReports: 4 },
    );
    expect(result.items.map((i) => i.key)).toContain('reports_orphaned');
    expect(result.items[0]?.severity).toBe('critical');
  });

  it('puts the critical findings first', () => {
    const result = employeeAttention(
      {
        ...base,
        status: 'terminated',
        terminationDate: null,
        managerEmployeeId: null,
        managerName: null,
        location: null,
      },
      quiet,
    );
    expect(result.items[0]?.severity).toBe('critical');
    expect(result.items.at(-1)?.severity).toBe('info');
  });
});
