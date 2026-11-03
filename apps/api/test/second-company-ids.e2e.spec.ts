import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CreateEmployeeSchema } from '@neway/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/common/auth/principal';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { employees } from '../src/database/schema/people';
import { companies } from '../src/database/schema/roster';
import { EmployeesService } from '../src/modules/people/employees.service';

/**
 * A second company adds people (owner, 2026-10-12: Harbor Line could not create a dispatcher). Numbers run
 * per company; ids are one key for every company, so the second company's EMP-1001 must not take
 * the first company's emp_1001.
 */
describe('A second company can add employees (e2e)', () => {
  let app: NestFastifyApplication;
  const companyId = `co_e2e_ids_${Date.now().toString(36)}`;
  const principal: Principal = { userId: 'u_e2e_ids', userName: 'E2E', companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: ['administrator'], permissions: new Set(['employees.create', 'employees.view', 'employees.edit', 'employees.view_financial', 'employees.manage']) };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.get(DatabaseService).db.insert(companies).values({ id: companyId, name: 'E2E second company' } as typeof companies.$inferInsert);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('numbers start at EMP-1001 again, with an id no other company holds', async () => {
    const svc = app.get(EmployeesService);
    const input = CreateEmployeeSchema.parse({ firstName: 'Franklin', lastName: 'Saint', workEmail: `franklin.${Date.now()}@example.test`, phone: '+998996967681', department: 'dispatch', position: 'Dispatcher', employmentType: 'full_time', hireDate: '2026-10-12' });
    const first = await svc.create(principal, input);
    expect(first.employeeNumber).toBe('EMP-1001');
    const [row] = await app.get(DatabaseService).db.select({ companyId: employees.companyId }).from(employees).where(eq(employees.id, first.id));
    expect(row?.companyId).toBe(companyId);
    const second = await svc.create(principal, { ...input, workEmail: `second.${Date.now()}@example.test` });
    expect(second.employeeNumber).toBe('EMP-1002');
    expect(second.id).not.toBe(first.id);
  });
});
