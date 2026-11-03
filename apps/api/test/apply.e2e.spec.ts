import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ApplyLink, Campaign, Lead, LeadApplication } from '@neway/shared';
import { and, count, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { DatabaseService } from '../src/database/database.service';
import { LeadsService } from '../src/modules/hiring/leads.service';
import { auditLogs, employees } from '../src/database/schema/people';
import {
  hiringApplyLinks,
  hiringLeadApplications,
  hiringLeads,
  smsPreferences,
} from '../src/database/schema/hiring';
import { companies, drivers } from '../src/database/schema/roster';
import { users } from '../src/database/schema/admin';

const HIRING = '/api/v1/hiring';
const PUBLIC = '/api/v1/public/apply';
const CONSENT =
  'By submitting, you agree to be contacted about employment opportunities by phone, email, or SMS.';

/**
 * The public driver application, end to end against the real database: a link resolves the
 * company on the server; a submission becomes a lead with status New and its answers, source,
 * campaign and UTM beside it; retries and double taps are one application; an existing lead keeps
 * its stage; nothing becomes an employee, a driver or a login; and the honeypot, the limits and the
 * tenant boundary hold.
 */
describe('Public driver application (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const slug = `e2e-${stamp}`;
  const otherSlug = `e2e-other-${stamp}`;
  const otherCompanyId = `co_e2e_${stamp}`;
  // Unique per run, valid NANP: 312-55x-xxxx is fine for an exchange starting 5.
  // Chosen in beforeAll among numbers no lead in this database has yet: other suites add 312-555
  // leads too, and a shared number would make this suite's duplicate counts someone else's.
  let tail = String(Math.floor(1000 + Math.random() * 8999));
  let nationalPhone = `312555${tail}`;
  let campaign: Campaign;
  let link: ApplyLink;

  // Each scenario gets its own client address so the per-address limiter is exercised on purpose.
  let address = 10;
  const nextAddress = () => `10.0.0.${(address += 1)}`;

  const get = (url: string, headers: Record<string, string> = {}) =>
    app.inject({ method: 'GET', url, headers });
  const send = (
    method: 'POST' | 'PATCH',
    url: string,
    payload: unknown,
    opts: { remoteAddress?: string; headers?: Record<string, string> } = {},
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: opts.remoteAddress,
      headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
      payload: payload as object,
    });

  const application = (overrides: Record<string, unknown> = {}) => ({
    submissionId: crypto.randomUUID(),
    fullName: `Marcus  E2e${stamp}`,
    phone: `(${nationalPhone.slice(0, 3)}) ${nationalPhone.slice(3, 6)}-${nationalPhone.slice(6)}`,
    experience: '  3 years OTR ',
    position: 'Lease operator, team',
    consent: true,
    website: '',
    completedInSeconds: 27,
    attribution: {
      utmSource: 'instagram',
      utmMedium: 'paid_social',
      utmCampaign: 'fall-drivers',
      utmContent: 'reel-1',
      fbclid: 'IwAR-test',
      referrer: 'https://l.instagram.com/',
    },
    ...overrides,
  });

  const leadsByPhone = async (): Promise<Lead[]> =>
    ((await get(`${HIRING}/leads?search=${nationalPhone}&pageSize=50`)).json() as { data: Lead[] })
      .data;

  const countRows = async (table: typeof employees | typeof drivers | typeof users) =>
    (await db.select({ value: count() }).from(table))[0]?.value ?? 0;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    for (let i = 0; i < 50 && (await leadsByPhone()).length > 0; i += 1) {
      tail = String(Math.floor(1000 + Math.random() * 8999));
      nationalPhone = `312555${tail}`;
    }
    expect(await leadsByPhone()).toHaveLength(0);

    const created = await send('POST', `${HIRING}/campaigns`, {
      name: `Instagram E2E ${stamp}`,
      channel: 'social',
      periodStart: '2026-10-01',
      spend: 0,
    });
    expect(created.statusCode, created.body).toBe(201);
    campaign = created.json() as Campaign;

    // A second company with its own link, written directly: the boundary is the point.
    await db.insert(companies).values({ id: otherCompanyId, name: `Other Carrier ${stamp}` });
    await db.insert(hiringApplyLinks).values({
      id: `alink_other_${stamp}`,
      companyId: otherCompanyId,
      slug: otherSlug,
      name: 'Other carrier link',
      source: 'social',
      consentText: CONSENT,
      privacyPolicyUrl: 'https://example.com/privacy',
      createdBy: 'e2e',
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('HR creates a link; consent wording and an https privacy policy are required', async () => {
    const missing = await send('POST', `${HIRING}/apply-links`, {
      name: 'No wording',
      slug: `${slug}-x`,
      privacyPolicyUrl: 'https://example.com/privacy',
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().errors.map((e: { path: string }) => e.path)).toContain('consentText');

    const insecure = await send('POST', `${HIRING}/apply-links`, {
      name: 'Insecure',
      slug: `${slug}-y`,
      consentText: CONSENT,
      privacyPolicyUrl: 'http://example.com/privacy',
    });
    expect(insecure.statusCode).toBe(422);

    const res = await send('POST', `${HIRING}/apply-links`, {
      name: `Instagram fall ${stamp}`,
      slug,
      source: 'social',
      campaignId: campaign.id,
      consentText: CONSENT,
      privacyPolicyUrl: 'https://northwind-freight.example/privacy-policy/',
      logoUrl: 'https://northwind-freight.example/media/logo-circle.png',
      shortName: 'NWF',
    });
    expect(res.statusCode, res.body).toBe(201);
    link = res.json() as ApplyLink;
    expect(link).toMatchObject({
      slug,
      active: true,
      campaignId: campaign.id,
      applicationCount: 0,
      shortName: 'NWF',
    });

    // A logo may be a path on this site, never another host disguised as one.
    const pathLogo = await send('PATCH', `${HIRING}/apply-links/${link.id}`, {
      logoUrl: '/brand/nwf-logo.png',
    });
    expect(pathLogo.statusCode, pathLogo.body).toBe(200);
    expect((pathLogo.json() as ApplyLink).logoUrl).toBe('/brand/nwf-logo.png');
    const hostLogo = await send('PATCH', `${HIRING}/apply-links/${link.id}`, {
      logoUrl: '//evil.example.com/logo.png',
    });
    expect(hostLogo.statusCode).toBe(422);
    const longShort = await send('PATCH', `${HIRING}/apply-links/${link.id}`, {
      shortName: 'Thirteen char',
    });
    expect(longShort.statusCode).toBe(422);

    const taken = await send('POST', `${HIRING}/apply-links`, {
      name: 'Duplicate',
      slug,
      consentText: CONSENT,
      privacyPolicyUrl: 'https://example.com/privacy',
    });
    expect(taken.statusCode).toBe(409);
  });

  it('a link to another company’s campaign is refused', async () => {
    const res = await send('POST', `${HIRING}/apply-links`, {
      name: 'Foreign campaign',
      slug: `${slug}-z`,
      campaignId: 'camp_does_not_belong',
      consentText: CONSENT,
      privacyPolicyUrl: 'https://example.com/privacy',
    });
    expect(res.statusCode).toBe(422);
  });

  it('a role without recruiting access cannot list or create links', async () => {
    const res = await get(`${HIRING}/apply-links`, { 'x-demo-role': 'operations' });
    expect(res.statusCode).toBe(403);
  });

  it('the public config names the company and its wording, and nothing else', async () => {
    const res = await get(`${PUBLIC}/${slug}`);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ['companyName', 'consentText', 'logoUrl', 'privacyPolicyUrl', 'shortName'].sort(),
    );
    expect(body.consentText).toBe(CONSENT);
    expect(body.shortName).toBe('NWF');
    expect(body.logoUrl).toBe('/brand/nwf-logo.png');
    expect((await get(`${PUBLIC}/no-such-link-${stamp}`)).statusCode).toBe(404);
    expect((await get(`${PUBLIC}/Bad Slug!`)).statusCode).toBe(404);
  });

  it('invalid answers are refused field by field and save nothing', async () => {
    const before = await leadsByPhone();
    const res = await send(
      'POST',
      `${PUBLIC}/${slug}`,
      application({ fullName: ' M ', consent: false, experience: undefined, position: '   ' }),
      { remoteAddress: nextAddress() },
    );
    expect(res.statusCode).toBe(422);
    const paths = (res.json().errors as { path: string }[]).map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(['fullName', 'consent', 'experience', 'position']),
    );

    const tooLong = await send(
      'POST',
      `${PUBLIC}/${slug}`,
      application({ fullName: 'x'.repeat(101), position: 'y'.repeat(81), completedInSeconds: 3601 }),
      { remoteAddress: nextAddress() },
    );
    expect(tooLong.statusCode).toBe(422);
    expect((tooLong.json().errors as { path: string }[]).map((e) => e.path)).toEqual(
      expect.arrayContaining(['fullName', 'position', 'completedInSeconds']),
    );

    const badPhone = await send('POST', `${PUBLIC}/${slug}`, application({ phone: '555-0100' }), {
      remoteAddress: nextAddress(),
    });
    expect(badPhone.statusCode).toBe(422);
    expect(badPhone.json().errors[0]).toMatchObject({
      path: 'phone',
      message: 'Enter a valid 10-digit phone number.',
    });
    expect(await leadsByPhone()).toHaveLength(before.length);
  });

  let leadId: string;
  const employeesBefore = { value: 0 };
  const driversBefore = { value: 0 };
  const usersBefore = { value: 0 };

  it('a valid application becomes a New lead in the right company with every answer', async () => {
    employeesBefore.value = await countRows(employees);
    driversBefore.value = await countRows(drivers);
    usersBefore.value = await countRows(users);

    const body = application({ companyId: otherCompanyId });
    const res = await send('POST', `${PUBLIC}/${slug}`, body, { remoteAddress: nextAddress() });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ status: 'received' });

    const leads = await leadsByPhone();
    expect(leads).toHaveLength(1);
    const lead = leads[0] as Lead;
    leadId = lead.id;
    // The link's consent names SMS: the driver's opt-in to texts about the application is on record.
    const [sms] = await db.select().from(smsPreferences).where(and(eq(smsPreferences.companyId, 'co_northwind'), eq(smsPreferences.phone, `+1${nationalPhone}`)));
    expect(sms).toMatchObject({ status: 'opted_in', optedInSource: 'applied_online' });
    expect(lead).toMatchObject({
      firstName: 'Marcus',
      lastName: `E2e${stamp}`,
      phone: `+1${nationalPhone}`,
      email: null,
      state: null,
      cdlClass: null,
      yearsExperience: null,
      notes: null,
      // The link is 'social'; the click carried utm_source=instagram, so the lead says Instagram.
      source: 'instagram',
      campaignId: campaign.id,
      status: 'new',
      applicationCount: 1,
      latestApplication: {
        experience: '3 years OTR',
        position: 'Lease operator, team',
      },
    });
    expect(lead.lastAppliedAt).not.toBeNull();

    // The client-sent companyId was ignored: the lead is in the link's company, not the other.
    const [row] = await db
      .select({ companyId: hiringLeads.companyId })
      .from(hiringLeads)
      .where(eq(hiringLeads.id, leadId));
    expect(row?.companyId).toBe(link ? await linkCompany(slug) : '');

    const apps = (await get(`${HIRING}/leads/${leadId}/applications`)).json() as LeadApplication[];
    expect(apps).toHaveLength(1);
    expect(apps[0]).toMatchObject({
      outcome: 'new_lead',
      link: { slug },
      campaignId: campaign.id,
      campaignName: campaign.name,
      answers: {
        fullName: `Marcus E2e${stamp}`,
        phone: `+1${nationalPhone}`,
        experience: '3 years OTR',
        position: 'Lease operator, team',
        completedInSeconds: 27,
      },
      attribution: { utmSource: 'instagram', utmCampaign: 'fall-drivers', fbclid: 'IwAR-test' },
      consent: { text: CONSENT, privacyPolicyUrl: 'https://northwind-freight.example/privacy-policy/' },
    });
  });

  const linkCompany = async (s: string) =>
    (
      await db
        .select({ companyId: hiringApplyLinks.companyId })
        .from(hiringApplyLinks)
        .where(eq(hiringApplyLinks.slug, s))
    )[0]?.companyId;

  it('creates no employee, driver or login, and writes a system audit entry', async () => {
    expect(await countRows(employees)).toBe(employeesBefore.value);
    expect(await countRows(drivers)).toBe(driversBefore.value);
    expect(await countRows(users)).toBe(usersBefore.value);
    const entries = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'lead'), eq(auditLogs.entityId, leadId)));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ action: 'create', actorType: 'system' });
  });

  it('the same submission sent again — sequentially or all at once — is one application', async () => {
    const body = application();
    const ip = nextAddress();
    const first = await send('POST', `${PUBLIC}/${slug}`, body, { remoteAddress: ip });
    expect(first.statusCode).toBe(201);
    const retry = await send('POST', `${PUBLIC}/${slug}`, body, { remoteAddress: ip });
    expect(retry.statusCode).toBe(201);

    const burst = application();
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        send('POST', `${PUBLIC}/${slug}`, burst, { remoteAddress: nextAddress() }),
      ),
    );
    expect(results.map((r) => r.statusCode)).toEqual([201, 201, 201, 201, 201]);

    const keys = await db
      .select({ value: count() })
      .from(hiringLeadApplications)
      .where(eq(hiringLeadApplications.leadId, leadId));
    // The first test's application, plus `body` once, plus `burst` once.
    expect(keys[0]?.value).toBe(3);
    expect(await leadsByPhone()).toHaveLength(1);
  });

  it('an existing lead who applies again keeps their stage; the application is added', async () => {
    const contacted = await send('POST', `${HIRING}/leads/${leadId}/contacted`, {});
    expect(contacted.statusCode).toBe(201);
    const before = (await get(`${HIRING}/leads/${leadId}`)).json() as Lead;
    expect(before.status).toBe('contacted');

    // Same person, phone typed another way, different answers.
    const res = await send(
      'POST',
      `${PUBLIC}/${slug}`,
      application({
        phone: `+1 ${nationalPhone}`,
        experience: '5 years',
        position: 'Owner operator',
      }),
      { remoteAddress: nextAddress() },
    );
    expect(res.statusCode).toBe(201);

    const after = (await get(`${HIRING}/leads/${leadId}`)).json() as Lead;
    expect(after.status).toBe('contacted');
    expect(after.contactedAt).toBe(before.contactedAt);
    expect(after.applicationCount).toBe(4);
    expect(after.latestApplication).toMatchObject({
      experience: '5 years',
      position: 'Owner operator',
    });
    expect(await leadsByPhone()).toHaveLength(1);

    const apps = (await get(`${HIRING}/leads/${leadId}/applications`)).json() as LeadApplication[];
    expect(apps[0]?.outcome).toBe('existing_lead');
    // History is kept: the first application still says what it said.
    expect(apps.at(-1)?.answers?.experience).toBe('3 years OTR');
  });

  it('a recruiter adding the same phone by hand meets the same duplicate rule', async () => {
    const res = await send('POST', `${HIRING}/leads`, {
      firstName: 'Marcus',
      lastName: 'Manual',
      phone: `312.555.${tail}`,
      source: 'referral',
    });
    expect(res.statusCode).toBe(409);
  });

  it('another name on a known phone is another driver: a new, unassigned lead', async () => {
    // Its own number, so the shared phone's daily limit stays with the tests that measure it.
    const phone = `224555${tail}`;
    const byPhone = async () =>
      ((await get(`${HIRING}/leads?search=${phone}&pageSize=50`)).json() as { data: Lead[] }).data;
    for (const fullName of ['Robert Stone', 'robert  STONE', 'Bobur Nazarov']) {
      const res = await send('POST', `${PUBLIC}/${slug}`, application({ fullName, phone }), {
        remoteAddress: nextAddress(),
      });
      expect(res.statusCode).toBe(201);
    }
    // The second spelling of the same name joins the first lead; the third name is its own lead.
    const leads = await byPhone();
    expect(leads).toHaveLength(2);
    expect(leads.find((l) => l.firstName === 'Robert')).toMatchObject({
      lastName: 'Stone',
      status: 'new',
      recruiterEmployeeId: null,
      applicationCount: 2,
    });
    expect(leads.find((l) => l.firstName === 'Bobur')).toMatchObject({ applicationCount: 1 });
  });

  it('a lead marked as test leaves the list, the counts and the phone match; nothing is deleted', async () => {
    const phone = `224556${tail}`;
    const byPhone = async () =>
      ((await get(`${HIRING}/leads?search=${phone}&pageSize=50`)).json() as { data: Lead[] }).data;
    const first = await send('POST', `${PUBLIC}/${slug}`, application({ fullName: 'Tess Mark', phone }), {
      remoteAddress: nextAddress(),
    });
    expect(first.statusCode).toBe(201);
    const [lead] = await byPhone();
    expect(lead).toBeDefined();
    const before = (await get(`${HIRING}/leads/summary`)).json() as { total: number };

    const [company] = await db
      .select({ companyId: hiringApplyLinks.companyId })
      .from(hiringApplyLinks)
      .where(eq(hiringApplyLinks.id, link.id));
    await app.get(LeadsService).markTest(
      { userId: 'e2e', userName: 'e2e', companyId: company?.companyId ?? '', companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set() },
      lead!.id,
      'e2e test data',
    );

    expect(await byPhone()).toHaveLength(0);
    expect(((await get(`${HIRING}/leads/summary`)).json() as { total: number }).total).toBe(before.total - 1);
    const [kept] = await db.select().from(hiringLeads).where(eq(hiringLeads.id, lead!.id));
    expect(kept).toMatchObject({ isTest: true, testReason: 'e2e test data' });
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, lead!.id), eq(auditLogs.action, 'mark_test')));
    expect(entry).toBeDefined();

    // The same driver applying again is a new, real lead, not joined to the hidden test one.
    const again = await send('POST', `${PUBLIC}/${slug}`, application({ fullName: 'Tess Mark', phone }), {
      remoteAddress: nextAddress(),
    });
    expect(again.statusCode).toBe(201);
    const visible = await byPhone();
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).not.toBe(lead!.id);
  });

  it('the honeypot answers "received" and saves nothing', async () => {
    const phone = `773555${tail}`;
    const res = await send(
      'POST',
      `${PUBLIC}/${slug}`,
      application({ phone, website: 'http://spam.example' }),
      { remoteAddress: nextAddress() },
    );
    expect(res.statusCode).toBe(201);
    const found = (await get(`${HIRING}/leads?search=${phone}`)).json() as { data: Lead[] };
    expect(found.data).toHaveLength(0);
  });

  it('a link resolves only to its own company', async () => {
    const phone = `630555${tail}`;
    const res = await send('POST', `${PUBLIC}/${otherSlug}`, application({ phone }), {
      remoteAddress: nextAddress(),
    });
    expect(res.statusCode).toBe(201);
    // Invisible to this company's HR…
    const mine = (await get(`${HIRING}/leads?search=${phone}`)).json() as { data: Lead[] };
    expect(mine.data).toHaveLength(0);
    // …and stored under the other company.
    const rows = await db
      .select({ companyId: hiringLeads.companyId })
      .from(hiringLeads)
      .where(eq(hiringLeads.phone, `+1${phone}`));
    expect(rows).toEqual([{ companyId: otherCompanyId }]);
    // A company cannot be chosen through the query string either.
    const forced = await send(
      'POST',
      `${PUBLIC}/${slug}?companyId=${otherCompanyId}`,
      application({ phone }),
      { remoteAddress: nextAddress() },
    );
    expect(forced.statusCode).toBe(400);
  });

  it('a switched-off link stops taking applications', async () => {
    const off = await send('PATCH', `${HIRING}/apply-links/${link.id}`, { active: false });
    expect(off.statusCode).toBe(200);
    expect((off.json() as ApplyLink).active).toBe(false);
    expect((await get(`${PUBLIC}/${slug}`)).statusCode).toBe(404);
    const res = await send('POST', `${PUBLIC}/${slug}`, application(), {
      remoteAddress: nextAddress(),
    });
    expect(res.statusCode).toBe(404);
    const on = await send('PATCH', `${HIRING}/apply-links/${link.id}`, { active: true });
    // 4 from the main phone and 3 from the "another name on a known phone" test.
    // Counts the test-lead check too (two more applications on this link, 2026-10-07).
    expect((on.json() as ApplyLink).applicationCount).toBe(9);
  });

  it('limits: one address gets 10 submissions per 10 minutes; one phone 5 a day', async () => {
    const ip = nextAddress();
    const codes: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      // Invalid on purpose: the address limit runs before validation, so this costs no rows.
      const res = await send(
        'POST',
        `${PUBLIC}/${slug}`,
        { submissionId: 'x' },
        { remoteAddress: ip },
      );
      codes.push(res.statusCode);
      if (res.statusCode === 429) {
        expect(res.headers['retry-after']).toBeDefined();
      }
    }
    expect(codes.slice(0, 10).every((c) => c === 422)).toBe(true);
    expect(codes[10]).toBe(429);

    // This phone already has four applications today; the fifth is accepted, the sixth refused.
    const fifth = await send('POST', `${PUBLIC}/${slug}`, application(), {
      remoteAddress: nextAddress(),
    });
    expect(fifth.statusCode).toBe(201);
    const sixth = await send('POST', `${PUBLIC}/${slug}`, application(), {
      remoteAddress: nextAddress(),
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBe(String(24 * 3600));
    // A retry of a submission already saved still answers "received".
    const replay = application();
    await db
      .update(hiringLeadApplications)
      .set({ submissionKey: replay.submissionId })
      .where(
        eq(
          hiringLeadApplications.id,
          (
            await db
              .select({ id: hiringLeadApplications.id })
              .from(hiringLeadApplications)
              .where(eq(hiringLeadApplications.leadId, leadId))
              .limit(1)
          )[0]?.id ?? '',
        ),
      );
    const replayed = await send('POST', `${PUBLIC}/${slug}`, replay, {
      remoteAddress: nextAddress(),
    });
    expect(replayed.statusCode).toBe(201);
  });

  let oneWordLeadId: string;

  it('a one-word name is a lead with an empty last name', async () => {
    const phone = `847555${tail}`;
    const res = await send(
      'POST',
      `${PUBLIC}/${slug}`,
      application({ fullName: '  Madonna ', phone }),
      { remoteAddress: nextAddress() },
    );
    expect(res.statusCode, res.body).toBe(201);
    const found = (await get(`${HIRING}/leads?search=${phone}`)).json() as { data: Lead[] };
    expect(found.data).toHaveLength(1);
    const lead = found.data[0] as Lead;
    oneWordLeadId = lead.id;
    expect(lead).toMatchObject({ firstName: 'Madonna', lastName: '', name: 'Madonna' });
    const apps = (await get(`${HIRING}/leads/${lead.id}/applications`)).json() as LeadApplication[];
    expect(apps[0]?.answers?.fullName).toBe('Madonna');
  });

  it('an international number typed with + is stored as E.164', async () => {
    const res = await send(
      'POST',
      `${PUBLIC}/${slug}`,
      application({ phone: `+44 20 7946 ${tail}` }),
      { remoteAddress: nextAddress() },
    );
    expect(res.statusCode, res.body).toBe(201);
    const rows = await db
      .select({ phone: hiringLeads.phone, status: hiringLeads.status })
      .from(hiringLeads)
      .where(eq(hiringLeads.phone, `+44207946${tail}`));
    expect(rows).toEqual([{ phone: `+44207946${tail}`, status: 'new' }]);

    // A + number with too few digits is refused with the page's own words.
    const short = await send('POST', `${PUBLIC}/${slug}`, application({ phone: '+998 90' }), {
      remoteAddress: nextAddress(),
    });
    expect(short.statusCode).toBe(422);
    expect(short.json().errors[0]).toMatchObject({
      path: 'phone',
      message: 'Enter the full number with its country code.',
    });
  });

  it('an application stored in an earlier format does not break the list or the drawer', async () => {
    const [company] = await db
      .select({ companyId: hiringApplyLinks.companyId })
      .from(hiringApplyLinks)
      .where(eq(hiringApplyLinks.id, link.id));
    // The shape the first version of the form stored, written straight to the table.
    await db.insert(hiringLeadApplications).values({
      id: `lapp_old_${stamp}`,
      companyId: company?.companyId ?? '',
      leadId: oneWordLeadId,
      applyLinkId: link.id,
      submissionKey: crypto.randomUUID(),
      outcome: 'existing_lead',
      source: 'social',
      answers: {
        fullName: 'Madonna',
        phone: `+1847555${tail}`,
        email: null,
        city: 'Joliet',
        state: 'IL',
        hasCdlA: 'yes',
        experience: '1_2yr',
        interest: 'company',
        setup: 'solo',
        start: 'immediately',
        message: null,
      },
      attribution: {},
      consentText: CONSENT,
      privacyPolicyUrl: 'https://example.com/privacy',
      consentedAt: new Date(),
      phoneKey: `1847555${tail}`,
      receivedAt: new Date(Date.now() + 1000),
    });

    const apps = await get(`${HIRING}/leads/${oneWordLeadId}/applications`);
    expect(apps.statusCode, apps.body).toBe(200);
    const list = apps.json() as LeadApplication[];
    expect(list).toHaveLength(2);
    expect(list[0]?.answers).toBeNull();
    expect(list[1]?.answers?.fullName).toBe('Madonna');

    const lead = await get(`${HIRING}/leads/${oneWordLeadId}`);
    expect(lead.statusCode, lead.body).toBe(200);
    expect((lead.json() as Lead).latestApplication).toMatchObject({
      experience: null,
      position: null,
    });
    const page = await get(`${HIRING}/leads?search=847555${tail}`);
    expect(page.statusCode, page.body).toBe(200);
  });
});
