import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { addDays, type HiringCase, type Lead } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { today as companyToday } from '@/lib/clock';
import { CandidateDocuments, HiringJourney } from './CandidateHiringParts';
import { HiringDashboardPage } from './HiringDashboardPage';

/**
 * HR is driver hiring: the dashboard shows who came in, where each driver is, who is stuck, and
 * who made it; the driver card shows the journey and the papers with Safety's answer on each.
 */
const today = companyToday();
const at = (days: number) => `${addDays(today, -days)}T14:00:00.000Z`;

const lead = (over: Partial<Lead>): Lead => ({
  id: 'l1', leadNumber: 'LD-1', firstName: 'A', lastName: 'B', name: 'A B', phone: '555', email: null,
  cdlClass: 'A', state: 'GA', yearsExperience: 2, source: 'facebook', campaignId: null,
  recruiterEmployeeId: null, recruiterName: 'Rita', notes: null, status: 'new', prequalification: null,
  prequalResult: null, applicantId: null, hiringCaseId: null, deadReason: null, applicationCount: 0, lastAppliedAt: null, latestApplication: null,
  createdAt: at(0), contactedAt: null, prequalifiedAt: null, convertedAt: null, deadAt: null, ...over,
});
const kase = (over: Partial<HiringCase>): HiringCase => ({
  id: 'c1', applicantId: 'ap1', driverId: 'drv_1', verificationCaseId: null, candidateName: 'C D',
  state: 'checks', stateSince: at(1), daysInState: 1, openedAt: at(3), closedAt: null, endReason: null,
  endNote: null, recruiterId: null, recruiterName: 'Rita', dotApplication: null, offerId: null,
  employeeId: null, hiredAt: null, firstDispatchAt: null, onboardingGate: null, events: [], ...over,
});

const LEADS = [
  lead({ id: 'fresh', name: 'Fresh Lead', createdAt: at(0) }),
  lead({ id: 'old', name: 'Old Lead', createdAt: at(4), source: 'referral' }),
  lead({ id: 'gone', name: 'Gone Lead', status: 'dead', deadAt: at(1), deadReason: 'Took another job' }),
];
const CASES = [
  kase({ id: 'docs', candidateName: 'Docs Driver', state: 'checks', stateSince: at(7) }),
  kase({ id: 'safety', candidateName: 'Safety Driver', state: 'safety_review', stateSince: at(1) }),
  kase({ id: 'hired', candidateName: 'Hired Driver', state: 'hired', stateSince: at(2) }),
  kase({ id: 'dq', candidateName: 'Dq Driver', state: 'disqualified', stateSince: at(2), endReason: 'safety_review_rejected' }),
];

const original = globalThis.fetch;
beforeEach(() => {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    const reply = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/hiring/leads') return reply({ data: LEADS, total: LEADS.length, page: 1, pageSize: 200 });
    if (path === '/hiring/cases') return reply(CASES);
    if (path === '/hiring/calendar') return reply([{ id: 'travel:1', caseId: 'hired', applicantId: 'ap1', candidateName: 'Hired Driver', kind: 'travel', date: today, at: null, detail: 'bus · Greyhound' }]);
    if (path === '/hiring/cases/docs/documents') {
      return reply({
        driverId: 'drv_1',
        documents: [
          { id: 'd1', requirementCode: 'cdl', status: 'verified', fileName: 'cdl.jpg', title: 'CDL', uploadedAt: at(3), rejectionReason: null },
          { id: 'd2', requirementCode: 'medical_card', status: 'rejected', fileName: 'med.pdf', title: 'Medical', uploadedAt: at(2), rejectionReason: 'Expired card' },
          { id: 'd3', requirementCode: 'clearinghouse_query', status: 'pending_review', fileName: 'ch.pdf', title: 'CH', uploadedAt: at(1), rejectionReason: null },
        ],
      });
    }
    if (path === '/hiring/cases/new/documents') return reply({ driverId: null, documents: [] });
    return inner(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

describe('driver hiring dashboard', () => {
  it('puts every driver on one step card, and flags the stuck ones', async () => {
    renderPage(<HiringDashboardPage />, { routePath: '/', path: '/' });
    const leadCard = await screen.findByTestId('step-lead');
    await waitFor(() => expect(within(leadCard).getByText('Fresh Lead')).toBeVisible());
    expect(within(leadCard).getByText('Old Lead')).toBeVisible();
    expect(within(screen.getByTestId('step-documents')).getByText('Docs Driver')).toBeVisible();
    expect(within(screen.getByTestId('step-hired')).getByText('Hired Driver')).toBeVisible();

    const stuck = screen.getByTestId('stuck-list');
    expect(within(stuck).getByText('Old Lead')).toBeVisible();
    expect(within(stuck).getByText('Docs Driver')).toBeVisible();
    expect(within(stuck).queryByText('Fresh Lead')).toBeNull();
    expect(within(stuck).queryByText('Safety Driver')).toBeNull();
  });

  it('counts who fell out and why, and where drivers came from', async () => {
    renderPage(<HiringDashboardPage />, { routePath: '/', path: '/' });
    const exits = await screen.findByTestId('exits');
    await waitFor(() => expect(within(exits).getByText('Gone Lead')).toBeVisible());
    expect(within(exits).getByText('Dq Driver')).toBeVisible();
    const sources = screen.getByTestId('sources');
    expect(within(sources).getByText('Facebook')).toBeVisible();
    expect(within(sources).getByText('Driver referral')).toBeVisible();
  });

  it('shows the week: travel, orientation and hires', async () => {
    renderPage(<HiringDashboardPage />, { routePath: '/', path: '/' });
    const cal = await screen.findByTestId('hiring-calendar');
    await waitFor(() => expect(within(cal).getByText('Hired Driver')).toBeVisible());
    expect(within(cal).getByText('Travel')).toBeVisible();
  });

  it('switching the period does not lose the step cards', async () => {
    const user = userEvent.setup();
    renderPage(<HiringDashboardPage />, { routePath: '/', path: '/' });
    await screen.findByText('Fresh Lead');
    await user.click(screen.getByRole('button', { name: 'This week' }));
    expect(screen.getByRole('button', { name: 'This week' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText('Fresh Lead')).toBeVisible();
  });
});

describe('the driver card', () => {
  it('shows the journey with the current step and what it waits on', () => {
    renderPage(<HiringJourney hiringCase={kase({ state: 'safety_review', daysInState: 1 })} />, { routePath: '/', path: '/' });
    return waitFor(() => {
      const journey = screen.getByTestId('hiring-journey');
      expect(within(journey).getByText('Safety review').closest('[aria-current]')).toHaveAttribute('aria-current', 'step');
      expect(within(journey).getByText(/Safety to approve or disqualify/)).toBeVisible();
    });
  });

  it('lists the papers with Safety’s answer on each, and the rejection reason', async () => {
    renderPage(<CandidateDocuments hiringCase={kase({ id: 'docs' })} canEdit />, { routePath: '/', path: '/' });
    const panel = await screen.findByTestId('candidate-documents');
    expect(within(screen.getByTestId('doc-cdl')).getByText('Approved by Safety')).toBeVisible();
    expect(within(screen.getByTestId('doc-medical_card')).getByText('Rejected by Safety')).toBeVisible();
    expect(within(screen.getByTestId('doc-medical_card')).getByText('Safety: Expired card')).toBeVisible();
    expect(within(screen.getByTestId('doc-clearinghouse_query')).getByText('Waiting for Safety')).toBeVisible();
    expect(within(screen.getByTestId('doc-pre_employment_drug_test')).getByRole('button', { name: 'Upload' })).toBeEnabled();
    expect(within(panel).getByText(/1 of 6/)).toBeVisible();
  });

  it('asks for the DOT application before any paper can be uploaded', async () => {
    renderPage(<CandidateDocuments hiringCase={kase({ id: 'new', driverId: null })} canEdit />, { routePath: '/', path: '/' });
    expect(await screen.findByText('No driver file yet')).toBeVisible();
  });
});
