import type { UnavailableCheck } from '../operations/attention.js';
import type { EmployeeRecord } from './employee.js';

/**
 * What needs attention on an employee record.
 *
 * The rule this file exists to enforce: a finding is only produced from a fact the caller actually
 * supplied. Anything that could not be checked is named in `unavailable` with what it would need,
 * so a quiet panel means "nothing is wrong", never "nothing was looked at". An HR screen that
 * invents alerts trains people to ignore alerts.
 */

export type AttentionSeverity = 'critical' | 'warning' | 'info';

/**
 * A finding about one person. The operations board's `AttentionItem` is a different shape on
 * purpose — that one aggregates a count of loads with the ids behind it, this one describes a
 * single record — so `UnavailableCheck` is reused and only the item type is new.
 */
export interface EmployeeAttentionItem {
  key: string;
  severity: AttentionSeverity;
  title: string;
  /** What to do about it, in the words of the person who has to do it. */
  detail: string;
}

export interface EmployeeAttention {
  items: EmployeeAttentionItem[];
  unavailable: UnavailableCheck[];
}

/** Facts about the person that live outside the employee record itself. */
export interface AttentionContext {
  /** Whether this employee has a driving profile. */
  hasDriverProfile: boolean;
  /** Requirements blocking dispatch on the linked driver, when compliance was consulted. */
  blockingRequirements?: number;
  /** Whether the linked driver currently holds a truck. */
  driverHoldsTruck?: boolean;
  /** Whether payroll has been consulted for this person. */
  payrollConsulted: boolean;
  /** Payslips found for this person in the periods consulted. */
  payslipCount?: number;
  /** Whether this employee manages anybody. */
  directReports: number;
}

export function employeeAttention(
  employee: EmployeeRecord,
  context: AttentionContext,
): EmployeeAttention {
  const items: EmployeeAttentionItem[] = [];
  const unavailable: UnavailableCheck[] = [];

  const working = employee.status === 'active' || employee.status === 'on_leave';

  // --- the record's own completeness -----------------------------------------------------------
  if (!employee.managerEmployeeId && employee.position !== 'Operations Manager') {
    items.push({
      key: 'no_manager',
      severity: 'warning',
      title: 'No manager assigned',
      detail:
        'Nobody is recorded as responsible for this person. Approvals and escalations have no route.',
    });
  }

  if (!employee.location) {
    items.push({
      key: 'no_location',
      severity: 'info',
      title: 'No work location recorded',
      detail: 'Terminal-level reporting will not include this person until a location is set.',
    });
  }

  // --- compensation ----------------------------------------------------------------------------
  if (context.hasDriverProfile) {
    // Correct and deliberate: a driver is paid from the pay plan on the driving profile, and a
    // second rate here would be a second answer to the same question.
  } else if (employee.payType === null || employee.payRate === null) {
    items.push({
      key: 'no_compensation',
      severity: working ? 'warning' : 'info',
      title: 'No compensation recorded',
      detail: 'Payroll cannot calculate pay for this person until a pay type and rate are set.',
    });
  }

  // --- employment consistency ------------------------------------------------------------------
  if (employee.status === 'terminated' && !employee.terminationDate) {
    items.push({
      key: 'terminated_without_date',
      severity: 'critical',
      title: 'Terminated with no termination date',
      detail: 'Final pay, benefits and access removal all key off that date.',
    });
  }

  if (employee.status === 'terminated' && context.driverHoldsTruck === true) {
    items.push({
      key: 'terminated_holds_truck',
      severity: 'critical',
      title: 'Terminated but still assigned a truck',
      detail: 'The unit cannot be dispatched to anyone else until the assignment is released.',
    });
  }

  if (!working && context.directReports > 0) {
    items.push({
      key: 'reports_orphaned',
      severity: 'critical',
      title: `${context.directReports} ${context.directReports === 1 ? 'person reports' : 'people report'} to someone who is not working`,
      detail: 'Reassign them to another manager before this record is archived.',
    });
  }

  // --- linked profiles -------------------------------------------------------------------------
  if (context.hasDriverProfile && context.blockingRequirements === undefined) {
    unavailable.push({
      key: 'driver_compliance',
      label: 'Dispatch eligibility',
      requires: 'the compliance engine to be consulted for this driver',
    });
  } else if (context.blockingRequirements !== undefined && context.blockingRequirements > 0) {
    items.push({
      key: 'driver_blocked',
      severity: 'critical',
      title: `${context.blockingRequirements} qualification requirement${context.blockingRequirements === 1 ? '' : 's'} blocking dispatch`,
      detail: 'This driver cannot be assigned a load until Safety clears them.',
    });
  }

  if (!context.payrollConsulted) {
    unavailable.push({
      key: 'payroll',
      label: 'Payroll standing',
      requires: 'a payroll period covering this person',
    });
  } else if (working && !context.hasDriverProfile && context.payslipCount === 0) {
    items.push({
      key: 'no_payslips',
      severity: 'info',
      title: 'No payslips in the periods on file',
      detail: 'This person has not appeared in a payroll run yet.',
    });
  }

  const rank: Record<AttentionSeverity, number> = { critical: 0, warning: 1, info: 2 };
  items.sort((a, b) => rank[a.severity] - rank[b.severity]);

  return { items, unavailable };
}
