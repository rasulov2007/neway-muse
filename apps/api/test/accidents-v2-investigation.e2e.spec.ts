import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, sql } from 'drizzle-orm';
import { SYSTEM_ROLES, accidentsV2 as A, safetyRules as R } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { memberships, membershipRoles, users } from '../src/database/schema/admin';
import { restrictedAccessLog, safetyDocumentVersions } from '../src/database/schema/accidents-v2';
import { companies } from '../src/database/schema/roster';
import { safetyCaseDocuments, safetyReviews } from '../src/database/schema/safety';
import { FilesService } from '../src/modules/files/files.service';
import { AccidentsV2Service } from '../src/modules/safety/accidents-v2/accidents-v2.service';
import { InvestigationV2Service } from '../src/modules/safety/accidents-v2/investigation-v2.service';
import { SafetyCoreService } from '../src/modules/safety/safety-core.service';
import { FIXTURE_CLOCK, FIXTURE_COMPANY, fx, loadAccidentFixtures, p1Seed } from './fixtures/accidents-v2-fixtures';

/**
 * Accident & Claims v2 — phase P4, investigation, evidence and restricted data (docs/accidents/ACCEPTANCE.md J1–J9, K1–K8,
 * N in full, O7 per role). Clock frozen at 2026-10-19T17:00:00Z; read-only checks on the shared fixture company, writes in
 * a fresh fictional company per run (local DB only).
 */

const RUN = Date.now().toString(36);
const MUT = `co_acc2_p4_${RUN}`;
const mx = (id: string) => `p4${RUN}_${id}`;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const EXPECTED: any = JSON.parse(readFileSync(join(__dirname, '../../../packages/shared/src/safety-rules/test-fixtures/fixtures-2026-10-19T17Z.json'), 'utf8'));

const permsOf = (role: string) => SYSTEM_ROLES.find((r) => r.code === role)?.permissions ?? [];
function principal(companyId: string, role: string, userId = `usr_acc2_${role}`, userName = `Test ${role}`, perms?: string[]): Principal {
  return { userId, userName, companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [role], permissions: new Set(perms ?? permsOf(role)) };
}
const err = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as { status: number; type?: string; detail?: string; extensions?: Record<string, unknown> };
  }
  throw new Error('expected an error');
};

describe('Accident & Claims v2 — P4 investigation, evidence and restricted data (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let acc: AccidentsV2Service;
  let inv: InvestigationV2Service;
  let files: FilesService;
  let core: SafetyCoreService;
  let originalClock: () => Date;

  const SM = principal(FIXTURE_COMPANY, 'safety_manager', 'usr_acc2_rm', 'Rachel Moore');
  const DISPATCH = principal(FIXTURE_COMPANY, 'dispatch_lead');
  const FLEET = principal(FIXTURE_COMPANY, 'fleet_manager');
  const MSM = principal(MUT, 'safety_manager', 'usr_acc2_p4_sm', 'Sam Safety');
  const MOPS = principal(MUT, 'operations_manager', 'usr_acc2_p4_ops', 'Olga Ops');
  const MFLEET = principal(MUT, 'fleet_manager', 'usr_acc2_p4_fleet', 'Fred Fleet');
  // There is no Safety Specialist role (owner: those rights sit with safety_manager); this is the SPEC §8.3 specialist profile.
  const SPECIALIST = principal(MUT, 'safety_specialist', 'usr_acc2_p4_spec', 'Sara Specialist', ['accidents.view', 'accidents.edit', 'accidents.determine', 'accidents.fleet']);

  const caseOf = (num: string) => p1Seed().cases.find((c) => c.number === num)!.id;

  beforeAll(async () => {
    setFeatureFlagForTests('accidents_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    acc = app.get(AccidentsV2Service);
    inv = app.get(InvestigationV2Service);
    files = app.get(FilesService);
    core = app.get(SafetyCoreService);
    originalClock = core.clock;
    core.clock = () => new Date(FIXTURE_CLOCK);
    await loadAccidentFixtures(db);
    await loadAccidentFixtures(db, { company: MUT, prefix: `p4${RUN}_` });
    await db.update(companies).set({ name: `Accidents v2 P4 run ${RUN} (TEST, fictional)` }).where(eq(companies.id, MUT));
    for (const [uid, first, role] of [
      ['usr_acc2_p4_sm', 'Sam', 'safety_manager'],
      ['usr_acc2_p4_ops', 'Olga', 'operations_manager'],
    ] as const) {
      await db.insert(users).values({ id: uid, email: `${uid}@acc2.test`, firstName: first, lastName: 'Test' }).onConflictDoNothing();
      await db.insert(memberships).values({ id: `mem_${uid}_${RUN}`, companyId: MUT, userId: uid, status: 'active' }).onConflictDoNothing();
      await db.insert(membershipRoles).values({ membershipId: `mem_${uid}_${RUN}`, roleId: `rol_${role}` }).onConflictDoNothing();
    }
  });

  afterAll(async () => {
    core.clock = originalClock;
    setFeatureFlagForTests('accidents_v2', null);
    await app.close();
  });

  // ================================================================================== the whole case equals the fixture

  it('N + tracks + expected evidence + blockers of the five showcase cases equal the fixture now that every record is stored', async () => {
    for (const num of ['ACC-2026-008', 'ACC-2026-015', 'ACC-2026-016', 'ACC-2026-017', 'ACC-2026-018']) {
      const d = await acc.detail(SM, fx(caseOf(num)));
      const e = EXPECTED.cases[num];
      expect(d.computed.summaryParts.map((p) => ({ prov: p.prov, restricted: Boolean(p.restricted), text: p.text })), num).toEqual(e.summaryForAuthorized);
      expect(d.computed.tracks.map((t) => ({ label: t.label, status: t.status, tone: t.tone, ...(t.detail ? { detail: t.detail } : {}) })), num).toEqual(e.tracks);
      expect(d.computed.expectedEvidence.map((x) => ({ label: x.label, ok: x.ok })), num).toEqual(e.expectedEvidence);
      expect(d.computed.advanceBlockers.map((b) => b.text), num).toEqual(e.advanceBlockers.map((b: string | { text: string }) => (typeof b === 'string' ? b : b.text)));
    }
    const d18 = await acc.detail(DISPATCH, fx(caseOf('ACC-2026-018')));
    expect(d18.computed.summaryParts.filter((p) => p.restricted).map((p) => p.text)).toEqual(EXPECTED.cases['ACC-2026-018'].summaryRestrictedSentenceForOthers);
  });

  it('K8 expected evidence of ACC-2026-018: photos ✓, driver statement ✓, police report ✗, dashcam ✓, repair estimate ✓, witness statement ✓', async () => {
    const d = await acc.detail(SM, fx(caseOf('ACC-2026-018')));
    expect(d.computed.expectedEvidence.map((x) => [x.label, x.ok])).toEqual([
      ['Scene or damage photos', true],
      ['Driver statement', true],
      ['Police report', false],
      ['Dashcam / video', true],
      ['Repair estimate', true],
      ['Witness statement', true],
    ]);
  });

  // ================================================================================== J — investigation & determinations

  it('J1 submitting without conclusion / fault / preventability is blocked and lists what is missing', async () => {
    const id = mx(caseOf('ACC-2026-016'));
    const d = await acc.detail(MSM, id);
    expect(d.case.investigation.status).toBe('in_progress');
    const e = await err(inv.action(MSM, id, 'submit', { version: d.version }));
    expect([e.status, (e.extensions?.errors as { message: string }[]).map((x) => x.message)]).toEqual([422, ['Write a conclusion', 'Record driver fault', 'Record preventability']]);
    expect(d.computed.investigation.submitMissing).toEqual(['Write a conclusion', 'Record driver fault', 'Record preventability']);
  });

  it('J4 setting fault "At fault" leaves preventability, CPDP, legal and insurance (claims) unchanged — never derived', async () => {
    const id = mx(caseOf('ACC-2026-016'));
    let d = await acc.detail(MSM, id);
    const before = { prevent: d.case.determinations.preventability, cpdp: d.case.determinations.cpdp, legal: d.case.determinations.legal, claims: d.computed.claims.map((k) => k.status) };
    await inv.determination(MSM, id, 'fault', { version: d.version, value: 'at_fault', basis: 'ECM: following distance under 1 s' });
    d = await acc.detail(MSM, id);
    expect(d.case.determinations.fault).toMatchObject({ value: 'at_fault', basis: 'ECM: following distance under 1 s', by: 'Sam Safety', at: FIXTURE_CLOCK.toISOString() });
    expect({ prevent: d.case.determinations.preventability, cpdp: d.case.determinations.cpdp, legal: d.case.determinations.legal, claims: d.computed.claims.map((k) => k.status) }).toEqual(before);
    expect((await err(inv.determination(MFLEET, id, 'fault', { version: d.version, value: 'not_at_fault' }))).status).toBe(403);
  });

  it('J2 / J3 approval (go-live §17): a specialist and an Operations Manager cannot approve (403); a Safety Manager approves → complete with approvedBy and date, track "Approved {date}"', async () => {
    const id = mx(caseOf('ACC-2026-016'));
    let d = await acc.detail(MSM, id);
    await inv.patch(MSM, id, { version: d.version, conclusion: 'Rear-end in a work-zone slowdown; following distance too short.' });
    d = await acc.detail(MSM, id);
    await inv.determination(SPECIALIST, id, 'preventability', { version: d.version, value: 'preventable', basis: 'Could have kept a safe following distance' });
    d = await acc.detail(MSM, id);
    await inv.action(SPECIALIST, id, 'submit', { version: d.version });
    d = await acc.detail(MSM, id);
    expect(d.case.investigation.status).toBe('in_review');
    const no = await err(inv.action(SPECIALIST, id, 'approve', { version: d.version }));
    expect([no.status, no.detail]).toEqual([403, 'An investigation is approved by a Safety Manager or the owner']);
    expect((await err(inv.action(MOPS, id, 'approve', { version: d.version }))).status).toBe(403);
    await inv.action(MSM, id, 'approve', { version: d.version });
    d = await acc.detail(MSM, id);
    expect([d.case.investigation.status, d.case.investigation.approvedBy, d.case.investigation.completedAt]).toEqual(['complete', 'Sam Safety', FIXTURE_CLOCK.toISOString()]);
    // Not self-approved: Sam neither owns nor submitted this investigation.
    const [audit] = (await db.execute(sql`select summary, reason from audit_logs where entity_id = ${id} and action = 'accident_investigation_approve' order by at desc limit 1`)) as unknown as Array<{ summary: string; reason: string | null }>;
    expect(audit?.summary).toBe('Investigation approved by Sam Safety');
    expect(d.computed.tracks.find((t) => t.key === 'inv')).toMatchObject({ status: 'Complete', tone: 'done', detail: `Approved ${R.fmtShort(FIXTURE_CLOCK.toISOString(), undefined, FIXTURE_CLOCK.getTime())}` });
    expect(d.computed.advanceBlockers.map((b) => b.text)).not.toContain('Investigation is not complete and approved');
  });

  it('J5 / J6 CPDP: refused on a non-recordable case (017) with the FMCSA wording; on 016 the choices and the RDR number', async () => {
    const id17 = mx(caseOf('ACC-2026-017'));
    const d17 = await acc.detail(MSM, id17);
    const e = await err(inv.determination(MSM, id17, 'cpdp', { version: d17.version, value: 'submitted', rdr: 'RDR 1' }));
    expect([e.status, e.detail]).toEqual([422, 'Only crashes that are DOT-reportable can be reviewed. Current: not recordable.']);
    const id16 = mx(caseOf('ACC-2026-016'));
    let d = await acc.detail(MSM, id16);
    expect((await err(inv.determination(MSM, id16, 'cpdp', { version: d.version, value: 'submitted' }))).detail).toBe('Enter the DataQs RDR number');
    await inv.determination(MSM, id16, 'cpdp', { version: d.version, value: 'submitted', rdr: 'RDR 2026-104477' });
    d = await acc.detail(MSM, id16);
    expect([d.case.determinations.cpdp.value, d.case.determinations.cpdp.rdr]).toEqual(['submitted', 'RDR 2026-104477']);
    expect(A.CPDP_VALUES).toEqual(['not_eligible', 'eligible_not_submitted', 'submitted', 'not_preventable', 'preventable', 'undecided']);
    expect(A.CPDP_ELIGIBLE_TYPES).toHaveLength(21);
    expect(A.CPDP_ELIGIBLE_TYPES[0]).toBe('CMV was struck in the rear by a motorist');
  });

  it('J7 legal liability is hidden from Fleet (redacted) and recorded only with accidents.legal', async () => {
    const d = await acc.detail(FLEET, fx(caseOf('ACC-2026-018')));
    expect(d.case.determinations.legal).toEqual({ value: 'unknown' });
    expect(d.redacted).toContain('determinations.legal');
    const id = mx(caseOf('ACC-2026-018'));
    const m = await acc.detail(MSM, id);
    expect((await err(inv.determination(MOPS, id, 'legal', { version: m.version, value: 'shared' }))).status).toBe(403);
    await inv.determination(MSM, id, 'legal', { version: m.version, value: 'disputed', basis: 'Liability contested by the other insurer' });
    expect((await acc.detail(MSM, id)).case.determinations.legal).toMatchObject({ value: 'disputed', by: 'Sam Safety' });
  });

  it('J8 / J9 corrective actions: a disciplinary review is not offered without accidents.discipline (403); as Safety Manager it is restricted and a lock card for others; it is a Safety review row for the driver', async () => {
    const id = mx(caseOf('ACC-2026-016'));
    let d = await acc.detail(MSM, id);
    const due = new Date(FIXTURE_CLOCK.getTime() + 7 * R.DAY).toISOString();
    expect((await err(inv.createCorrectiveAction(SPECIALIST, id, { version: d.version, kind: 'Disciplinary review', title: 'Review', assigneeId: 'usr_acc2_p4_sm', dueAt: due }))).status).toBe(403);
    const disc = await inv.createCorrectiveAction(MSM, id, { version: d.version, kind: 'Disciplinary review', title: 'Written warning — second preventable', assigneeId: 'usr_acc2_p4_sm', dueAt: due });
    d = await acc.detail(MSM, id);
    const coach = await inv.createCorrectiveAction(SPECIALIST, id, { version: d.version, kind: 'Coaching', title: 'Following-distance coaching with video review', assigneeId: 'usr_acc2_p4_sm', dueAt: due });
    const [row] = await db.select().from(safetyReviews).where(eq(safetyReviews.id, coach.id));
    expect([row?.accidentId, row?.driverId, row?.kind, row?.actionKind, row?.number]).toEqual([id, mx('d2'), 'coaching', 'Coaching', expect.stringMatching(/^REV-/)]);
    const [discRow] = await db.select().from(safetyReviews).where(eq(safetyReviews.id, disc.id));
    expect(discRow?.restricted).toBe(true);
    const asSpecialist = await acc.detail(SPECIALIST, id);
    const lock = asSpecialist.computed.investigation.correctiveActions.find((a) => a.id === disc.id)!;
    expect([lock.locked, lock.title, lock.evidence]).toEqual([true, 'Restricted personnel action', null]);
    expect(JSON.stringify(asSpecialist).includes('Written warning')).toBe(false);
    const ca = (await acc.detail(MSM, id)).computed.investigation.correctiveActions.find((a) => a.id === coach.id)!;
    await inv.patchCorrectiveAction(MSM, coach.id, { version: ca.version, status: 'Completed', completionEvidence: 'Ride-along on Oct 22' });
    expect((await acc.detail(MSM, id)).computed.investigation.correctiveActions.find((a) => a.id === coach.id)).toMatchObject({ status: 'Completed', evidence: 'Ride-along on Oct 22' });
  });

  it('investigation records: fact, question → resolve, statement, factor level, review item, vehicle and witness (contact restricted)', async () => {
    const id = mx(caseOf('ACC-2026-017'));
    const v = async () => (await acc.detail(MSM, id)).version;
    await inv.addFact(MSM, id, { version: await v(), text: 'Lot lighting out at the fuel island', source: 'Site visit', provenance: 'verified' });
    await inv.addQuestion(MSM, id, { version: await v(), text: 'Was the bollard painted?', ownerId: 'usr_acc2_p4_sm' });
    let d = await acc.detail(MSM, id);
    const q = d.computed.investigation.questions.find((x) => x.text === 'Was the bollard painted?')!;
    expect(q.owner?.name).toBe('Sam Test');
    await inv.resolveQuestion(MSM, id, q.id, { version: d.version, answer: 'No — paint worn off' });
    await inv.addStatement(MSM, id, { version: await v(), party: 'Fuel desk clerk', kind: 'Witness', summary: 'Heard the impact, saw the truck reversing' });
    await inv.addFactor(MSM, id, { version: await v(), category: 'Environment', label: 'Poor lighting' });
    d = await acc.detail(MSM, id);
    const f = d.case.investigation.factors.find((x) => x.label === 'Poor lighting')!;
    await inv.factorLevel(MSM, id, f.id, { version: d.version, level: 'confirmed' });
    await inv.reviewItem(MSM, id, 'site_photos', { version: await v(), label: 'Site photos of the island', state: 'requested' });
    await inv.addVehicle(MSM, id, { version: await v(), description: 'Fuel island bollard', ownerName: 'Truck stop', damage: 'Bent' });
    await inv.addWitness(MSM, id, { version: await v(), name: 'Jo Clerk', contact: '(555) 010-4242', note: 'Saw the truck reversing' });
    d = await acc.detail(MSM, id);
    expect(d.case.investigation.facts.some((x) => x.text === 'Lot lighting out at the fuel island' && x.provenance === 'verified')).toBe(true);
    expect(d.case.investigation.questions.find((x) => x.id === q.id)?.answer).toBe('No — paint worn off');
    expect(d.case.investigation.factors.find((x) => x.id === f.id)?.level).toBe('confirmed');
    expect(d.computed.investigation.reviewItems.find((x) => x.key === 'site_photos')?.state).toBe('requested');
    expect(d.computed.investigation.witnesses.find((w) => w.name === 'Jo Clerk')?.contact).toBe('(555) 010-4242');
    const fleet = await acc.detail(MFLEET, id);
    expect(fleet.computed.investigation.witnesses.find((w) => w.name === 'Jo Clerk')?.contact).toBeNull();
    expect(JSON.stringify(fleet).includes('010-4242')).toBe(false);
    expect(d.computed.expectedEvidence.find((x) => x.label === 'Witness statement')).toMatchObject({ ok: false });
  });

  // ================================================================================== K — evidence, legal hold, restricted

  it('K1 / K2 / K3 upload two files (category, description, uploader, size, SHA-256); a new version keeps v1; removal hides with a reason, file kept', async () => {
    const id = mx(caseOf('ACC-2026-016'));
    const store = (name: string, body: string) => files.store(MUT, { fileName: name, contentType: 'application/pdf', bytes: Buffer.from(body), uploadedBy: 'Sam Safety' });
    const f1 = await store('repair-estimate-a.pdf', 'estimate A');
    const f2 = await store('repair-estimate-b.pdf', 'estimate B');
    const d = await acc.detail(MSM, id);
    const up = await inv.upload(MSM, id, { version: d.version, files: [{ fileId: f1.id }, { fileId: f2.id }], category: 'Repair estimate', description: 'Shop estimates' });
    expect(up.ids).toHaveLength(2);
    let list = await inv.evidence(MSM, id, false);
    const it1 = list.items.find((x) => x.id === up.ids[0])!;
    expect([it1.category, it1.description, it1.uploadedBy, it1.versions?.[0]?.sha256]).toEqual(['Repair estimate', 'Shop estimates', 'Sam Safety', expect.stringMatching(/^[0-9a-f]{64}$/)]);
    const f3 = await store('repair-estimate-a-revised.pdf', 'estimate A revised');
    await inv.newVersion(MSM, up.ids[0]!, { fileId: f3.id, note: 'Revised after teardown' });
    list = await inv.evidence(MSM, id, false);
    const v2 = list.items.find((x) => x.id === up.ids[0])!;
    expect([v2.version, v2.versions?.map((x) => x.v), v2.fileId]).toEqual([2, [2, 1], f3.id]);
    expect((await inv.download(MSM, up.ids[0]!, 1)).fileId).toBe(f1.id);
    await inv.remove(MSM, up.ids[1]!, { reason: 'Uploaded to the wrong case' });
    list = await inv.evidence(MSM, id, false);
    expect(list.items.some((x) => x.id === up.ids[1])).toBe(false);
    const withRemoved = await inv.evidence(MSM, id, true);
    expect(withRemoved.items.find((x) => x.id === up.ids[1])?.removed?.reason).toBe('Uploaded to the wrong case');
    expect((await files.read(MUT, f2.id)).bytes.toString()).toBe('estimate B');
    // The file of a version cannot be deleted through /files either.
    expect((await err(files.softDelete(MSM, f3.id, 'Try to delete evidence'))).status).toBe(409);
  });

  it('K4 / K5 under legal hold removal is refused (API 409 legal-hold and the database trigger); a hard delete is impossible', async () => {
    const id = mx(caseOf('ACC-2026-018'));
    const list = await inv.evidence(MSM, id, false);
    const doc = list.items.find((x) => !x.restricted)!;
    const e = await err(inv.remove(MSM, doc.id, { reason: 'Try during hold' }));
    expect([e.status, e.type]).toEqual([409, '/problems/legal-hold']);
    await expect(db.update(safetyCaseDocuments).set({ voidedAt: FIXTURE_CLOCK, voidReason: 'direct' }).where(eq(safetyCaseDocuments.id, doc.id))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/legal hold/i) } });
    await expect(db.delete(safetyCaseDocuments).where(eq(safetyCaseDocuments.id, doc.id))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/cannot be deleted/i) } });
    const [anyVersion] = await db.select().from(safetyDocumentVersions).where(eq(safetyDocumentVersions.companyId, MUT)).limit(1);
    if (anyVersion) await expect(db.update(safetyDocumentVersions).set({ note: 'changed' }).where(eq(safetyDocumentVersions.id, anyVersion.id))).rejects.toMatchObject({ cause: { message: expect.stringMatching(/immutable/i) } });
  });

  it('K6 ACC-2026-018 as Dispatch: medical sentence replaced, restricted timeline entries masked, Medical/Legal evidence lock cards, witness contacts hidden — no restricted value in any response', async () => {
    const id = fx(caseOf('ACC-2026-018'));
    const d = await acc.detail(DISPATCH, id);
    const events = await acc.events(DISPATCH, id);
    const ev = await inv.evidence(DISPATCH, id, true);
    const board = await acc.board(DISPATCH, { chip: 'all', range: '90d' });
    const summary = await acc.summary(DISPATCH, { range: '90d' });
    expect(d.computed.summaryParts.find((p) => p.restricted)?.text).toBe('Medical details are restricted.');
    expect(events.filter((e) => e.restricted).every((e) => e.text === 'Restricted entry')).toBe(true);
    const locks = ev.items.filter((x) => x.locked);
    expect(locks.map((x) => x.category).sort()).toEqual(expect.arrayContaining(['Legal (restricted)', 'Medical (restricted)']));
    expect(locks.every((x) => x.name === null && x.fileId === null && x.versions === null)).toBe(true);
    expect(d.computed.investigation.witnesses.every((w) => w.contact === null)).toBe(true);
    const json = JSON.stringify([d, events, ev, board, summary]);
    for (const secret of ['neck pain', 'Attorney letter', 'EMS transport notes', 'Two sedan occupants transported']) expect(json.includes(secret), secret).toBe(false);
  });

  it('K7 the same as Safety Manager: visible, and each read is logged in restricted_access_log', async () => {
    const id = fx(caseOf('ACC-2026-018'));
    const SM = principal(FIXTURE_COMPANY, 'safety_manager', `usr_acc2_p4_k7_${RUN}`, 'Rachel Moore');
    const before = (await db.select({ n: sql<number>`count(*)::int` }).from(restrictedAccessLog).where(and(eq(restrictedAccessLog.companyId, FIXTURE_COMPANY), eq(restrictedAccessLog.accidentId, id), eq(restrictedAccessLog.actorId, SM.userId))))[0]?.n ?? 0;
    const d = await acc.detail(SM, id);
    expect(d.case.injuries.detailsRestricted).toContain('neck pain');
    const ev = await inv.evidence(SM, id, false);
    expect(ev.items.find((x) => x.category === 'Legal (restricted)')?.name).toBe('Attorney letter of representation.pdf');
    await acc.events(SM, id);
    const rows = await db.select().from(restrictedAccessLog).where(and(eq(restrictedAccessLog.companyId, FIXTURE_COMPANY), eq(restrictedAccessLog.accidentId, id), eq(restrictedAccessLog.actorId, SM.userId)));
    expect(rows.length - before).toBe(3);
    expect(rows.map((r) => r.resource)).toEqual(expect.arrayContaining([expect.stringContaining('accident.detail:medical'), 'accident.evidence.list', 'accident.timeline']));
    expect(rows.every((r) => r.actorName === 'Rachel Moore')).toBe(true);
  });

  it('O7 redaction per role on the case: restricted values reach only safety_manager and administrator', async () => {
    const id = fx(caseOf('ACC-2026-018'));
    for (const role of ['fleet_manager', 'maintenance', 'dispatcher', 'dispatch_lead', 'accounting', 'operations_manager', 'read_only']) {
      const d = await acc.detail(principal(FIXTURE_COMPANY, role), id);
      const json = JSON.stringify(d);
      expect(json.includes('neck pain'), role).toBe(false);
      expect(d.redacted, role).toContain('injuries.medicalDetails');
    }
    for (const role of ['safety_manager', 'administrator']) {
      const d = await acc.detail(principal(FIXTURE_COMPANY, role), id);
      expect(JSON.stringify(d).includes('neck pain'), role).toBe(true);
    }
  });

  it('go-live §17: a Safety Manager may approve an investigation they own — allowed, and audited and logged as self-approved', async () => {
    const id = mx(caseOf('ACC-2026-017'));
    await db.execute(sql`UPDATE safety_accidents SET investigation_status = 'in_review', investigation_owner_id = ${MSM.userId} WHERE id = ${id}`);
    const d = await acc.detail(MSM, id);
    await inv.action(MSM, id, 'approve', { version: d.version, note: 'Small team' });
    const after = await acc.detail(MSM, id);
    expect([after.case.investigation.status, after.case.investigation.approvedBy]).toEqual(['complete', 'Sam Safety']);
    const [audit] = (await db.execute(sql`select summary, reason from audit_logs where entity_id = ${id} and action = 'accident_investigation_approve' order by at desc limit 1`)) as unknown as Array<{ summary: string; reason: string | null }>;
    expect(audit).toEqual({ summary: 'Investigation approved by Sam Safety (self-approved: the approver ran this investigation)', reason: 'Self-approved — Small team' });
    const events = await acc.events(MSM, id);
    expect(JSON.stringify(events)).toContain('self-approved');
  });

  it('go-live §17: disciplinary reviews stay restricted — the Operations Manager has neither accidents.discipline nor accidents.approve', () => {
    const ops = SYSTEM_ROLES.find((r) => r.code === 'operations_manager')!.permissions;
    expect(ops).not.toContain('accidents.discipline');
    expect(ops).not.toContain('accidents.approve');
    expect(SYSTEM_ROLES.filter((r) => r.permissions.includes('accidents.approve')).map((r) => r.code).sort()).toEqual(['administrator', 'safety_manager']);
  });
});
