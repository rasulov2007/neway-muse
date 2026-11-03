import { DEPARTMENT_LABELS, type EmployeeDepartment, type EmployeeRecord } from '@neway/shared';

/**
 * How employee values are worded on screen.
 *
 * Apart from the components so a page file exports only components — Fast Refresh cannot preserve
 * state across an edit to a module that mixes the two.
 */

export function departmentLabel(department: EmployeeDepartment): string {
  return DEPARTMENT_LABELS[department] ?? department;
}

export function employmentTypeLabel(type: EmployeeRecord['employmentType']): string {
  return {
    full_time: 'Full time',
    part_time: 'Part time',
    contractor: 'Contractor',
    temporary: 'Temporary',
  }[type];
}
