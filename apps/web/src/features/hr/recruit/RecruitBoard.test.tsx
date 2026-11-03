import { screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecruitBoard, RecruitBoardCard } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { RecruitBoardView } from './RecruitBoard';

/** Consent sent and Consent received are two columns side by side (owner, 2026-10-26). */
const scope = { scope: 'all' as const, label: 'All leads', own: { employeeId: 'emp_1057', name: 'Marina Valentine' }, canSeeAll: true };
const card = (over: Partial<RecruitBoardCard>): RecruitBoardCard => ({
  key: 'lead_1',
  leadId: 'lead_1',
  caseId: null,
  applicantId: null,
  name: 'Cameron Bolton',
  source: 'instagram',
  sourceLabel: 'Instagram',
  progress: 'consent_sent',
  stage: 'consent_pending',
  nextStep: 'Waiting for consent',
  followUpOn: null,
  followUpState: 'none',
  recruiter: { employeeId: 'emp_1057', name: 'Marina Valentine' },
  createdAt: '2026-10-20T12:00:00.000Z',
  lastNote: null,
  column: 'consent_sent',
  phone: '5551234567',
  driverType: null,
  consent: 'sent',
  safety: null,
  stageSince: null,
  costCents: null,
  ...over,
});

const board: RecruitBoard = {
  cards: [
    card({ key: 'lead_1', name: 'Cameron Bolton' }),
    card({ key: 'lead_2', leadId: 'lead_2', name: 'Sonia Fennimore' }),
    card({ key: 'lead_3', leadId: 'lead_3', name: 'Ali Karimov', progress: 'consent_received', nextStep: 'Send to Safety', consent: 'received', column: 'consent_received' }),
  ],
  scope,
  today: '2026-10-26',
};

const original = globalThis.fetch;
beforeEach(() => {
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    const reply = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/hiring/recruiting/board') return reply(board);
    if (path === '/hiring/recruiting/recruiters') return reply([{ employeeId: 'emp_1057', name: 'Marina Valentine' }]);
    return inner(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

describe('Recruiting board consent columns', () => {
  it('shows Consent sent and Consent received as two adjacent columns, each with its own count', async () => {
    renderPage(<RecruitBoardView search={{} as never} update={() => {}} canSeeAll canManage />);
    await screen.findByText('Ali Karimov');

    const columns = screen.getAllByRole('region').map((r) => r.getAttribute('data-testid'));
    const i = columns.indexOf('board-column-consent_sent');
    expect(i).toBeGreaterThan(-1);
    expect(columns.slice(i - 1, i + 3)).toEqual(['board-column-lead_screening', 'board-column-consent_sent', 'board-column-consent_received', 'board-column-safety_review']);
    expect(columns).not.toContain('board-column-consent');

    const sent = screen.getByTestId('board-column-consent_sent');
    const received = screen.getByTestId('board-column-consent_received');
    expect(within(sent).getByRole('heading', { name: 'Consent sent' })).toBeInTheDocument();
    expect(within(received).getByRole('heading', { name: 'Consent received' })).toBeInTheDocument();
    expect(within(sent).getByTestId('column-count')).toHaveTextContent('2');
    expect(within(received).getByTestId('column-count')).toHaveTextContent('1');
    expect(within(sent).getAllByTestId('board-card').map((c) => c.getAttribute('data-progress'))).toEqual(['consent_sent', 'consent_sent']);
    expect(within(received).getByText('Ali Karimov')).toBeInTheDocument();
    expect(within(received).getByText('Send to Safety')).toBeInTheDocument();
    expect(within(sent).getAllByText('Waiting for consent')).toHaveLength(2);
  });
});
