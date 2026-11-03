import { describe, expect, it } from 'vitest';
import {
  CreateEmployeeSchema,
  CreateStaffEmployeeSchema,
  PAY_TYPE_LABELS,
  SelfProfileSchema,
  payTypeForDepartment,
  placementForRoles,
  profileGateApplies,
  resolvePayType,
} from './employee.js';
import { splitFullName } from '../hiring/apply.js';
import { SETTING_DEFAULTS, SETTING_SCHEMAS, SETTINGS, SELF_PROFILE_SETTING } from '../admin/settings.js';

const staff = {
  firstName: 'Ann',
  lastName: 'Lee',
  workEmail: 'ann@example.com',
  phone: '5551234567',
  department: 'safety',
  hireDate: '2026-10-26',
  employmentType: 'full_time',
} as const;

describe('pay type follows the department (owner, 2026-10-26)', () => {
  it('Dispatch is Commission (KPI); every other department is Fixed', () => {
    expect(payTypeForDepartment('dispatch')).toBe('commission');
    for (const d of ['safety', 'maintenance', 'accounting', 'hr', 'fleet', 'management', 'driver_relations'] as const) {
      expect(payTypeForDepartment(d)).toBe('salary');
    }
    expect(PAY_TYPE_LABELS.commission).toBe('Commission (KPI)');
    expect(PAY_TYPE_LABELS.salary).toBe('Fixed');
  });

  it('derives the pay type when none is asked for', () => {
    expect(resolvePayType({ department: 'dispatch' })).toEqual({ ok: true, payType: 'commission' });
    expect(resolvePayType({ department: 'hr', requested: null })).toEqual({ ok: true, payType: 'salary' });
  });

  it('refuses a pay type that disagrees with the department', () => {
    const wrong = resolvePayType({ department: 'dispatch', requested: 'salary' });
    expect(wrong.ok).toBe(false);
    expect(resolvePayType({ department: 'safety', requested: 'commission' }).ok).toBe(false);
    expect(resolvePayType({ department: 'safety', requested: 'hourly' }).ok).toBe(false);
    expect(resolvePayType({ department: 'safety', requested: 'salary' })).toEqual({ ok: true, payType: 'salary' });
  });

  it('a driver row carries no pay type at all', () => {
    expect(resolvePayType({ department: 'dispatch', position: 'Driver' })).toEqual({ ok: true, payType: null });
    expect(resolvePayType({ department: 'dispatch', position: 'Driver', requested: 'commission' }).ok).toBe(false);
  });
});

describe('Create employee form rules', () => {
  it('title is optional', () => {
    const parsed = CreateEmployeeSchema.parse({ ...staff });
    expect(parsed.position).toBe('');
  });

  it('shift time is required on the Create employee dialog', () => {
    expect(CreateStaffEmployeeSchema.safeParse({ ...staff }).success).toBe(false);
    expect(CreateStaffEmployeeSchema.safeParse({ ...staff, shiftTime: '  ' }).success).toBe(false);
    expect(CreateStaffEmployeeSchema.safeParse({ ...staff, shiftTime: '6 PM – 6 AM' }).success).toBe(true);
  });
});

describe('Complete your profile', () => {
  const body = { fullName: 'Ann Lee', phone: '5551234567', shiftTime: 'Day' };

  it('accepts the personal fields', () => {
    const parsed = SelfProfileSchema.parse({ ...body, nickname: 'Annie', dateOfBirth: '1990-04-02' });
    expect(parsed.nickname).toBe('Annie');
    expect(parsed.expectedUpdatedAt).toBeNull();
  });

  it('requires a first and last name, a phone and a shift', () => {
    expect(SelfProfileSchema.safeParse({ ...body, fullName: 'Ann' }).success).toBe(false);
    expect(SelfProfileSchema.safeParse({ ...body, phone: '' }).success).toBe(false);
    expect(SelfProfileSchema.safeParse({ ...body, shiftTime: '' }).success).toBe(false);
  });

  it('refuses role, department, title, pay, status or another record id in the body', () => {
    for (const extra of [
      { roleIds: ['rol_admin'] },
      { department: 'dispatch' },
      { position: 'Administrator' },
      { payType: 'commission' },
      { payRate: 9000 },
      { status: 'active' },
      { employeeId: 'emp_1001' },
      { hireDate: '2020-01-01' },
    ]) {
      expect(SelfProfileSchema.safeParse({ ...body, ...extra }).success).toBe(false);
    }
  });

  it('splits a full name into first and last', () => {
    expect(splitFullName('  Jane  van der Berg ')).toEqual({ firstName: 'Jane', lastName: 'van der Berg' });
  });

  it('places dispatch roles in Dispatch on commission, the rest Fixed', () => {
    expect(placementForRoles(['dispatcher'])).toMatchObject({ department: 'dispatch', title: 'Dispatcher', payType: 'commission' });
    expect(placementForRoles(['dispatch_lead', 'dispatcher'])).toMatchObject({ title: 'Dispatch Lead', payType: 'commission' });
    expect(placementForRoles(['safety_manager'])).toMatchObject({ department: 'safety', payType: 'salary' });
    expect(placementForRoles(['read_only'])).toMatchObject({ department: 'management', title: '', payType: 'salary', mapped: false });
  });

  it('the gate holds only non-administrators without an employee record', () => {
    const base = { enabled: true, roles: ['dispatcher'], isOwner: false, isPlatformAdmin: false, hasEmployee: false, completedAt: null };
    expect(profileGateApplies(base)).toBe(true);
    expect(profileGateApplies({ ...base, enabled: false })).toBe(false);
    expect(profileGateApplies({ ...base, roles: ['administrator'] })).toBe(false);
    expect(profileGateApplies({ ...base, isOwner: true })).toBe(false);
    expect(profileGateApplies({ ...base, isPlatformAdmin: true })).toBe(false);
    expect(profileGateApplies({ ...base, hasEmployee: true })).toBe(false);
    expect(profileGateApplies({ ...base, completedAt: new Date() })).toBe(false);
  });

  it('is a company setting that defaults on', () => {
    expect(SETTINGS.some((s) => s.key === SELF_PROFILE_SETTING)).toBe(true);
    expect(SETTING_DEFAULTS[SELF_PROFILE_SETTING]).toBe(true);
    expect(SETTING_SCHEMAS[SELF_PROFILE_SETTING]?.safeParse(false).success).toBe(true);
  });
});
