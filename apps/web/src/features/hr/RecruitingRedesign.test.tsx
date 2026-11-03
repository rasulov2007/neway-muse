import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays, type ApplicantRecord, type HiringCase, type Lead } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { today as companyToday } from '@/lib/clock';
import { DotApplicationWizard } from './DotApplicationWizard';
import { DriverCandidateProfile } from './DriverCandidateProfile';
import { RecruitingOverview } from './RecruitingOverview';
import { periodFromSearch } from './recruiting-kit';

/**
 * The Recruiting redesign (2026-09-30): the overview's nine tiles and their lists, Follow up that
 * records rather than sends, the candidate profile, and the six-section DOT application.
 */
const today = companyToday();
const at = (days: number) => `${addDays(today, -days)}T14:00:00.000Z`;

const lead = (over: Partial<Lead>): Lead => ({
  id: 'l1', leadNumber: 'LD-1', firstName: 'A', lastName: 'B', name: 'A B', phone: '+15555550100', email: 'a@b.test',
  cdlClass: 'A', state: 'IL', yearsExperience: 2, source: 'facebook', campaignId: null, recruiterEmployeeId: null,
  recruiterName: null, notes: null, status: 'new', prequalification: null, prequalResult: null, applicantId: null,
  hiringCaseId: null, deadReason: null, applicationCount: 0, lastAppliedAt: null, latestApplication: null, createdAt: at(0), contactedAt: null, prequalifiedAt: null, convertedAt: null, deadAt: null,
  ...over,
});
const kase = (over: Partial<HiringCase>): HiringCase => ({
  id: 'c1', applicantId: 'ap1', driverId: null, verificationCaseId: null, candidateName: 'Case Driver', state: 'application',
  stateSince: at(0), daysInState: 0, openedAt: at(1), closedAt: null, endReason: null, endNote: null, recruiterId: null,
  recruiterName: null, dotApplication: null, offerId: null, employeeId: null, hiredAt: null, firstDispatchAt: null,
  onboardingGate: null, events: [{ id: 'e1', caseId: 'c1', fromState: null, toState: 'application', at: at(0), byId: null, byName: 'Rita', reason: null, note: null, source: 'user' }],
  ...over,
});
const candidate: ApplicantRecord = {
  id: 'ap1', applicantNumber: 'CAND-1002', jobOpeningId: null, jobTitle: null, firstName: 'Sam', lastName: 'Test', name: 'Sam Test',
  email: 'shax@test.local', phone: '+998911202212', position: 'Driver', department: 'dispatch', location: 'IL', source: 'website',
  stage: 'applied', closedReason: null, assignedRecruiterEmployeeId: null, recruiterName: null, driverType: 'company',
  hiredEmployeeId: null, notes: null, lastActivityAt: null, interviewCount: 0, nextInterviewAt: null, createdAt: at(1),
  appliedOn: addDays(today, -1), hiredOn: null,
} as unknown as ApplicantRecord;

let posts: { path: string; body: unknown }[] = [];
let savedForm: unknown = null;
const original = globalThis.fetch;

beforeEach(() => {
  posts = [];
  savedForm = null;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (method !== 'GET') posts.push({ path, body });
    if (path === '/hiring/leads') {
      return reply({ data: [
        lead({ id: 'fresh', name: 'Fresh Lead', createdAt: at(0) }),
        lead({ id: 'late', name: 'Late Lead', createdAt: at(4), source: 'referral' }),
        lead({ id: 'conv', name: 'Case Driver', status: 'converted', hiringCaseId: 'c1', applicantId: 'ap1' }),
      ], total: 3, page: 1, pageSize: 200 });
    }
    if (path === '/hiring/cases') return reply([kase({})]);
    if (path === '/hiring/calendar') return reply([]);
    if (path === '/hiring/follow-ups/latest') return reply([]);
    if (path === '/hr/recruiting/jobs') return reply([]);
    if (path === '/hiring/cases/c1/activity') return reply([{ id: 'a1', at: at(0), kind: 'stage', title: 'Moved to application', detail: null, byName: 'Rita' }]);
    if (path === '/hiring/cases/c1/documents') return reply({ driverId: null, documents: [] });
    if (path === '/hiring/cases/c1/costs') return reply({ entries: [], summary: { total: 0 } });
    if (path === '/hiring/cases/c1/dot-application/link' && method === 'GET') return reply({ link: null });
    if (path === '/hiring/cases/c1/dot-application' && method === 'GET') {
      return reply({ application: savedForm ? { id: 'dot1', hiringCaseId: 'c1', applicantId: 'ap1', status: 'draft', form: savedForm, ssnLast4: null, documentId: null, driverId: null, verificationCaseId: null, consentIds: [], submittedAt: null, submittedBy: null, updatedAt: new Date().toISOString() } : null });
    }
    if (path === '/hiring/cases/c1/dot-application' && method === 'PUT') {
      const { ssn: _ssn, ...form } = body as Record<string, unknown>;
      void _ssn;
      savedForm = form;
      return reply({ id: 'dot1', hiringCaseId: 'c1', applicantId: 'ap1', status: 'draft', form, ssnLast4: null, documentId: null, driverId: null, verificationCaseId: null, consentIds: [], submittedAt: null, submittedBy: null, updatedAt: new Date().toISOString() });
    }
    if (path.endsWith('/follow-ups')) return reply({ entityId: 'late', at: new Date().toISOString(), byName: 'Me', method: 'call', outcome: 'no_answer', note: null }, 201);
    return inner(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

describe('Recruiting overview', () => {
  it('shows the four figures and nine stage tiles with their real counts', async () => {
    renderPage(<RecruitingOverview period={periodFromSearch({}, today)} today={today} onOpenTab={() => {}} />, { routePath: '/', path: '/' });
    const tile = await screen.findByTestId('stage-lead');
    await waitFor(() => expect(within(tile).getByText('2')).toBeVisible());
    expect(within(screen.getByTestId('stage-application')).getByText('1')).toBeVisible();
    expect(within(screen.getByTestId('stage-hired')).getByText('0')).toBeVisible();
    expect(screen.getByText('Active candidates')).toBeVisible();
    expect(screen.getByText('Needs attention')).toBeVisible();
    expect(screen.getByText('Hired this month')).toBeVisible();
    expect(screen.getByText('Open positions')).toBeVisible();
  });

  it('selecting a tile lists that stage; an empty stage says so once', async () => {
    const user = userEvent.setup();
    renderPage(<RecruitingOverview period={periodFromSearch({}, today)} today={today} onOpenTab={() => {}} />, { routePath: '/', path: '/' });
    await user.click(await screen.findByTestId('stage-application'));
    expect(screen.getByTestId('stage-application')).toHaveAttribute('aria-selected', 'true');
    const list = screen.getByTestId('stage-list');
    expect(within(list).getByText('Case Driver')).toBeVisible();
    expect(within(list).getByText(/Next: Complete DOT application/)).toBeVisible();
    await user.click(screen.getByTestId('stage-orientation'));
    expect(screen.getAllByTestId('stage-empty')).toHaveLength(1);
  });

  it('an overdue lead shows how late it is, and Follow up records (never sends)', async () => {
    const user = userEvent.setup();
    renderPage(<RecruitingOverview period={periodFromSearch({}, today)} today={today} onOpenTab={() => {}} />, { routePath: '/', path: '/' });
    await user.click(await screen.findByTestId('stage-lead'));
    const late = await screen.findByTestId('candidate-late');
    expect(within(late).getByTestId('overdue')).toHaveTextContent('3 days overdue');
    await user.click(within(late).getByRole('button', { name: 'Follow up' }));
    const dialog = screen.getByTestId('follow-up-dialog');
    expect(screen.getByText(/Recording does not send anything/)).toBeVisible();
    expect(within(dialog).getByRole('link', { name: /Call/ })).toHaveAttribute('href', 'tel:+15555550100');
    await user.click(screen.getByRole('button', { name: 'Record follow-up' }));
    await waitFor(() => expect(posts.some((p) => p.path === '/hiring/leads/late/follow-ups')).toBe(true));
    expect(posts.find((p) => p.path === '/hiring/leads/late/follow-ups')?.body).toMatchObject({ method: 'call', outcome: 'no_answer' });
  });
});

describe('Candidate profile', () => {
  it('shows progress, the next action and the document prerequisite from the real stage', async () => {
    renderPage(<DriverCandidateProfile candidate={candidate} hiringCase={kase({})} />, { routePath: '/', path: '/' });
    const progress = await screen.findByTestId('hiring-progress');
    expect(within(progress).getByText('Step 3 of 9')).toBeVisible();
    expect(within(screen.getByTestId('next-action')).getByText('Start the DOT application')).toBeVisible();
    expect(await screen.findByText('Available after application submission')).toBeVisible();
    expect(screen.queryByText(/office stage vocabulary/)).toBeNull();
  });

  it('keeps Drop from hiring in the overflow menu, with a reason and confirmation', async () => {
    const user = userEvent.setup();
    renderPage(<DriverCandidateProfile candidate={candidate} hiringCase={kase({})} />, { routePath: '/', path: '/' });
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(screen.getByRole('menuitem', { name: /Drop from hiring/ }));
    expect(screen.getByText('Drop Case Driver from hiring?')).toBeVisible();
    expect(screen.getByLabelText('Drop reason')).toBeVisible();
  });
});

describe('DOT application wizard', () => {
  it('shows six sections, keeps typed values across sections, and saves an incomplete draft', async () => {
    const user = userEvent.setup();
    renderPage(<DotApplicationWizard hiringCase={kase({})} candidate={candidate} canEdit />, { routePath: '/', path: '/' });
    await screen.findByTestId('dot-wizard');
    for (const s of ['identity', 'addresses', 'licenses', 'employment', 'incidents', 'certification']) {
      expect(screen.getByTestId(`section-${s}`)).toBeVisible();
    }
    expect(screen.getByTestId('section-state-addresses')).toHaveTextContent('Not started');

    await user.click(screen.getByTestId('section-addresses'));
    await user.type(screen.getByLabelText(/^Street/), '12 Elm St');
    expect(screen.getByTestId('section-state-addresses')).toHaveTextContent('In progress');
    await user.click(screen.getByTestId('section-identity'));
    await user.click(screen.getByTestId('section-addresses'));
    expect(screen.getByLabelText(/^Street/)).toHaveValue('12 Elm St');
    expect(screen.getByTestId('save-state')).toHaveTextContent('unsaved changes');

    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    await waitFor(() => expect(screen.getByTestId('save-state')).toHaveTextContent(/saved/));
    expect((savedForm as { addresses: { street: string }[] }).addresses[0]?.street).toBe('12 Elm St');
  });

  it('submits only from Review & certify, which lists what is missing by section', async () => {
    const user = userEvent.setup();
    renderPage(<DotApplicationWizard hiringCase={kase({})} candidate={candidate} canEdit />, { routePath: '/', path: '/' });
    await screen.findByTestId('dot-wizard');
    expect(screen.queryByRole('button', { name: 'Submit and file in the DQF' })).toBeNull();
    await user.click(screen.getByTestId('section-certification'));
    expect(screen.getByRole('button', { name: 'Submit and file in the DQF' })).toBeVisible();
    const review = screen.getByTestId('review-summary');
    expect(within(review).getByText(/still needed before submission/)).toBeVisible();
    expect(within(review).getAllByRole('button', { name: 'Address history' }).length).toBeGreaterThan(0);
  });
});
