import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DotAppSafetyDetail } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { DotAppReview } from './DotAppReviewPage';

const detail = (over: Partial<DotAppSafetyDetail> = {}): DotAppSafetyDetail =>
  ({
    id: 'dapp_1',
    companyId: 'cmp_test',
    subjectKey: 'case_1',
    candidateName: 'Ali Karimov',
    driverId: 'drv_2118',
    position: 'Company Driver',
    status: 'under_review',
    createdAt: '2026-10-20T12:00:00.000Z',
    submittedAt: '2026-10-25T15:00:00.000Z',
    approvedAt: null,
    hiredAt: null,
    sectionsComplete: 11,
    sectionsTotal: 11,
    link: null,
    version: 4,
    answers: { company: { position: 'Company Driver' }, fmcsr: { disqualified: 'No', suspended: 'Yes' } },
    ssnLast4: '1234',
    templates: [],
    templateVersions: {},
    signatures: [],
    uploads: [],
    employerForms: {},
    onboarding: {},
    employerChecklist: [
      { key: 'annual', title: 'Annual Review of Driving Record', done: true },
      { key: 'cov', title: 'Certification of Violations — Date of Employment & Home Terminal', done: false },
    ],
    onboardingChecklist: [],
    changeRequests: [],
    consentLinks: [],
    missing: [],
    internalNote: null,
    rejectedReason: null,
    rosterDriverId: null,
    company: { name: 'HARBOR LINE TRANSPORT INC', legalName: 'HARBOR LINE TRANSPORT INC', phone: null, address: null, locations: [] },
    activity: [],
    emails: [],
    permissions: { canReview: true, canHire: true },
    ...over,
  }) as DotAppSafetyDetail;

let current = detail();
const original = globalThis.fetch;
beforeEach(() => {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    if (path === '/safety/dot-applications/dapp_1') return new Response(JSON.stringify(current), { status: 200, headers: { 'content-type': 'application/json' } });
    return inner(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

describe('Safety → Applications review', () => {
  it('keeps Approve disabled until every employer form is done', async () => {
    current = detail();
    renderPage(<DotAppReview applicationId="dapp_1" />);
    const approve = await screen.findByTestId('dot-app-approve');
    expect(approve).toBeDisabled();
    expect(screen.getByTestId('approve-hint')).toHaveTextContent('Complete the employer forms first.');
    expect(within(screen.getByTestId('decision-panel')).getByText('Employer forms 1/2 complete')).toBeInTheDocument();
  });

  it('enables Approve once the employer checklist is complete', async () => {
    current = detail({ employerChecklist: [{ key: 'annual', title: 'Annual Review of Driving Record', done: true }] });
    renderPage(<DotAppReview applicationId="dapp_1" />);
    const approve = await screen.findByTestId('dot-app-approve');
    expect(approve).toBeEnabled();
    expect(screen.queryByTestId('approve-hint')).toBeNull();
  });

  it('shows "Driver submitted" and "Safety approved" as two separate states', async () => {
    current = detail({ status: 'approved', approvedAt: '2026-10-26T15:00:00.000Z' });
    renderPage(<DotAppReview applicationId="dapp_1" />);
    expect(await screen.findByTestId('pill-submitted')).toHaveTextContent(/Driver submitted/);
    expect(screen.getByTestId('pill-approved')).toHaveTextContent(/Safety approved/);
  });

  it('flags a Yes answer with a warning word', async () => {
    current = detail();
    renderPage(<DotAppReview applicationId="dapp_1" />);
    const flags = await screen.findByTestId('driver-flags');
    const row = within(flags).getByText('License ever suspended / revoked').closest('li')!;
    expect(within(row).getByText('Yes')).toBeInTheDocument();
  });
});
