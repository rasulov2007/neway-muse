import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { VerificationCase } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { VerificationPipeline } from './VerificationPipeline';

function step(
  key: string,
  label: string,
  stage: VerificationCase['stage'],
  status: VerificationCase['steps'][number]['status'],
  blocker: string | null = null,
): VerificationCase['steps'][number] {
  return {
    key,
    label,
    stage,
    status,
    requirementCode: null,
    blocker,
    completedAt: status === 'complete' ? '2026-09-01T10:00:00.000Z' : null,
    completedBy: status === 'complete' ? 'Dana Ortiz' : null,
  };
}

const stuckAtConsent: VerificationCase = {
  id: 'vc_1',
  driverId: 'drv_9',
  driverName: 'Nia Park',
  stage: 'consent',
  openedAt: '2026-08-25T09:00:00.000Z',
  ownerId: 'usr_5',
  ownerName: 'Monica Alvarez',
  safetyReviewStatus: 'not_started',
  safetyReviewAt: null,
  safetyReviewBy: null,
  steps: [
    step('application', 'Application', 'recruiting', 'complete'),
    step('cdl', 'CDL', 'document_collection', 'complete'),
    step('medical_card', 'Medical card', 'document_collection', 'complete'),
    step(
      'consent_mvr',
      'MVR consent',
      'consent',
      'blocked',
      'Consent declined on Sep 2; driver must re-authorize before an MVR can be pulled',
    ),
    step('consent_psp', 'PSP consent', 'consent', 'complete'),
    step('mvr_review', 'MVR review', 'screening', 'not_started'),
    step('decision', 'Decision', 'decision', 'not_started'),
  ],
  decision: null,
  decisionAt: null,
  decisionBy: null,
  conditions: [],
  decisionNote: null,
  daysInStage: 9,
};

const readyForDecision: VerificationCase = {
  ...stuckAtConsent,
  id: 'vc_2',
  driverId: 'drv_10',
  driverName: 'Omar Haddad',
  stage: 'decision',
  safetyReviewStatus: 'in_progress',
  steps: stuckAtConsent.steps.map((s) =>
    s.key === 'decision' ? s : { ...s, status: 'complete' as const, blocker: null },
  ),
  daysInStage: 1,
};

const recordVerificationDecision = vi.fn();
const startVerificationReview = vi.fn();

vi.mock('./compliance-api', () => ({
  listVerificationCases: vi.fn(() => Promise.resolve([stuckAtConsent, readyForDecision])),
  recordVerificationDecision: (...args: unknown[]) => recordVerificationDecision(...args),
  startVerificationReview: (...args: unknown[]) => startVerificationReview(...args),
}));

function render(caseId?: string) {
  const onOpenCase = vi.fn();
  const utils = renderPage(<VerificationPipeline caseId={caseId} onOpenCase={onOpenCase} />);
  return { ...utils, onOpenCase };
}

describe('VerificationPipeline', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    startVerificationReview.mockResolvedValue({ ...stuckAtConsent, safetyReviewStatus: 'in_progress' });
    recordVerificationDecision.mockResolvedValue({
      ...readyForDecision,
      decision: 'approved',
      stage: 'active',
    });
  });

  it('places each driver at the stage holding them and says exactly why', async () => {
    render();
    // The stage rail renders empty first; wait for the loaded case before counting.
    await screen.findByText('Nia Park');
    const stages = screen.getByLabelText('Verification stages');
    const consent = within(stages).getByText('Consent').closest('li');
    expect(consent).toHaveTextContent('1');
    expect(consent).toHaveTextContent('1 blocked');

    const list = screen.getByTestId('verification-cases');
    const nia = within(list).getByText('Nia Park').closest('li');
    expect(nia).toHaveTextContent('MVR consent');
    expect(nia).toHaveTextContent(/driver must re-authorize/);
    expect(nia).toHaveTextContent('9d in stage');
  });

  it('refuses any approval while the file is incomplete, lists why, and still allows a rejection', async () => {
    render('vc_1');
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/MVR consent: Consent declined/)).toBeInTheDocument();
    expect(within(drawer).getByText(/Safety review has not been started/)).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Approved' })).toBeDisabled();
    expect(within(drawer).getByRole('button', { name: 'Conditional' })).toBeDisabled();

    await userEvent.click(within(drawer).getByRole('button', { name: 'Record decision' }));
    await waitFor(() =>
      expect(recordVerificationDecision).toHaveBeenCalledWith('vc_1', {
        decision: 'rejected',
        conditions: [],
        note: null,
      }),
    );
  });

  it('starts the safety review from the decision panel', async () => {
    render('vc_1');
    const drawer = await screen.findByRole('dialog');
    await userEvent.click(within(drawer).getByRole('button', { name: 'Start safety review' }));
    await waitFor(() => expect(startVerificationReview).toHaveBeenCalledWith('vc_1'));
  });

  it('records a clean approval when every check is accepted and the review is under way', async () => {
    render('vc_2');
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/Every mandatory check is reviewed and accepted/)).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Approved' })).toBeEnabled();
    await userEvent.click(within(drawer).getByRole('button', { name: 'Record decision' }));
    await waitFor(() =>
      expect(recordVerificationDecision).toHaveBeenCalledWith(
        'vc_2',
        expect.objectContaining({ decision: 'approved' }),
      ),
    );
  });
});
