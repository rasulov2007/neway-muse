import { describe, expect, it } from 'vitest';
import { employeesSearchSchema } from './employees-search';
import { employeesPageScope, toEmployeeQuery } from './useEmployees';

/**
 * The list is served by the database, so what matters here is that the URL turns into the right
 * request. A filter that is silently dropped between the two looks exactly like a filter that
 * found nothing.
 */
describe('the employee list query', () => {
  it('carries every filter through to the request', () => {
    const search = employeesSearchSchema.parse({
      q: 'chen',
      status: 'active',
      department: 'safety',
      position: 'Dispatcher',
      employmentType: 'contractor',
      location: 'Naperville, IL',
      manager: 'emp_1001',
      workforce: 'driver',
      hiredFrom: '2024-01-01',
      hiredTo: '2026-01-01',
      page: 3,
      sort: 'hireDate',
      sortDir: 'desc',
    });
    const query = toEmployeeQuery(search);
    expect(query).toMatchObject({
      search: 'chen',
      status: 'active',
      department: 'safety',
      position: 'Dispatcher',
      employmentType: 'contractor',
      location: 'Naperville, IL',
      managerEmployeeId: 'emp_1001',
      workforce: 'driver',
      hiredFrom: '2024-01-01',
      hiredTo: '2026-01-01',
      page: 3,
      sort: 'hireDate',
      sortDir: 'desc',
    });
  });

  it('asks for a page the server will serve rather than the whole workforce', () => {
    const query = toEmployeeQuery(employeesSearchSchema.parse({}));
    expect(query.page).toBe(1);
    expect(Number(query.pageSize)).toBeLessThanOrEqual(200);
  });

  it('leaves people who have left out unless they are asked for', () => {
    expect(toEmployeeQuery(employeesSearchSchema.parse({})).includeInactive).toBeUndefined();
    expect(
      toEmployeeQuery(employeesSearchSchema.parse({ includeInactive: '1' })).includeInactive,
    ).toBe('true');
  });

  it('sends a profile scope only when the Employees page asks for one', () => {
    const plain = employeesSearchSchema.parse({});
    expect(toEmployeeQuery(plain).scope).toBeUndefined();
    expect(employeesPageScope(plain)).toBe('profile_complete');
    expect(employeesPageScope(employeesSearchSchema.parse({ view: 'incomplete' }))).toBe('profile_incomplete');
    expect(toEmployeeQuery(plain, 'profile_complete').scope).toBe('profile_complete');
  });

  it('parses a numeric-looking filter the router turned into a number', () => {
    // The router parses `?manager=1001` into a number; a plain string schema would reject it and
    // blank the page, which is a bug this project has already been bitten by once.
    const search = employeesSearchSchema.parse({ manager: 1001, page: 2 });
    expect(search.manager).toBe('1001');
    expect(search.page).toBe(2);
  });
});
