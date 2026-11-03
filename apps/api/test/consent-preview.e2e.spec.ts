import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { hiringLeads } from '../src/database/schema';
import { ne } from 'drizzle-orm';
import { ConsentService } from '../src/modules/hiring/consent.service';

/**
 * A consent link opened by a signed-in recruiter is a preview (owner, 2026-10-14): it is not bound
 * to the office computer and does not count as opened, so the driver's phone still opens it - and
 * once the driver has it, another device is still refused. Fictional subject.
 */
describe('Consent link staff preview (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  let leadId = '';
  const meta = (device: string, staffCompanyId: string | null = null) => ({ ip: '127.0.0.1', secure: true, userAgent: 'e2e', device, staffCompanyId });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    const [l] = await app.get(DatabaseService).db.select({ id: hiringLeads.id, companyId: hiringLeads.companyId }).from(hiringLeads).where(ne(hiringLeads.status, 'dead')).limit(1);
    if (!l) throw new Error('A lead is needed');
    companyId = l.companyId;
    leadId = l.id;
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('previews for staff without binding; the driver binds; a third device is refused', async () => {
    const consents = app.get(ConsentService);
    const principal = { userId: 'usr_e2e_recruiter', userName: 'E2E Recruiter', companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set<string>() } as Principal;
    const key = leadId;
    const issued = await consents.issue(principal, { companyId, leadId, caseId: null, subjectKey: key, name: 'Test Driver', applicantId: null, leadStatus: null, caseState: null, key });
    const token = new URL(issued.url).hash.replace(/^#token=/, '');

    const office = await consents.context(token, meta('office-device-0000000001', companyId));
    expect(office.preview).toBe(true);

    const driver = await consents.context(token, meta('driver-phone-000000000001'));
    expect(driver.preview).toBeUndefined();

    // Staff can still look after the driver has it; a stranger cannot.
    expect((await consents.context(token, meta('office-device-0000000001', companyId))).preview).toBe(true);
    await expect(consents.context(token, meta('someone-else-0000000001'))).rejects.toMatchObject({ status: 403 });
    // Signed in to a different company is not staff for this link.
    await expect(consents.context(token, meta('someone-else-0000000001', 'co_other'))).rejects.toMatchObject({ status: 403 });
  });
});
