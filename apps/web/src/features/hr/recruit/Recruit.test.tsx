import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DriverApplicationSubmissionView, RecruitCandidate, RecruitList, RecruitMetrics, RecruitNote, RecruitRow } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { CopyLinkModal, HireModal } from './RecruitModals';
import { DriverApplicationPanel, PersonalApplication, SendApplicationModal } from './DriverApplicationParts';
import { RecruitCandidatePage } from './RecruitCandidatePage';

/**
 * Recruiting home and candidate (owner's redesign, 2026-10-08): the three numbers, equal badges,
 * filters that live in the URL and reach the server, notes that keep the text when a save fails,
 * a copied link that never claims it was sent, and a Hire that waits for real prerequisites.
 */
const scope = { scope: 'mine' as const, label: 'Assigned to Grace Harper', own: { employeeId: 'emp_1148', name: 'Grace Harper' }, canSeeAll: true };
const row = (over: Partial<RecruitRow>): RecruitRow => ({
  key: 'lead_1',
  leadId: 'lead_1',
  caseId: null,
  applicantId: null,
  name: 'Cameron Bolton',
  source: 'instagram',
  sourceLabel: 'Instagram',
  progress: 'new',
  stage: 'new_lead',
  nextStep: 'Contact driver',
  followUpOn: '2026-10-08',
  followUpState: 'today',
  recruiter: { employeeId: 'emp_1148', name: 'Grace Harper' },
  createdAt: '2026-10-08T12:00:00.000Z',
  lastNote: null,
  ...over,
});
const list = (rows: RecruitRow[]): RecruitList => ({
  rows,
  total: rows.length,
  page: 1,
  pageSize: 10,
  counts: { all: rows.length, new: 1, in_progress: rows.length - 1, hired: 0, closed: 0, active: rows.length },
  followUpDue: 1,
  scope,
  today: '2026-10-08',
});
const metrics: RecruitMetrics = { active: 21, followUpDue: 2, hiredThisMonth: 0, month: '2026-10', today: '2026-10-08', scope };

const candidate = (over: Partial<RecruitCandidate> = {}): RecruitCandidate => ({
  key: 'lead_1',
  leadId: 'lead_1',
  caseId: null,
  applicantId: null,
  leadNumber: 'LEAD-1005',
  applicantNumber: null,
  name: 'Cameron Bolton',
  firstName: 'Cameron',
  lastName: 'Bolton',
  version: '1.-',
  phone: '(555) 123-4567',
  email: 'cameron@example.com',
  location: 'Phoenix, AZ',
  source: 'instagram',
  sourceLabel: 'Instagram',
  createdAt: '2026-10-08T12:00:00.000Z',
  recruiter: { employeeId: 'emp_1148', name: 'Grace Harper' },
  progress: 'new',
  nextStep: 'Send application',
  followUp: null,
  lead: { status: 'prequalified', prequalified: true, prequalFailed: null, deadReason: null },
  caseState: null,
  driverId: null,
  application: {
    state: 'none', submittedAt: null, certifiedAt: null, certifiedName: null, submittedVia: null, reviewedAt: null, reviewedBy: null,
    returnedAt: null, returnNote: null, documentId: null, link: null, markedSentAt: null, markedSentBy: null, external: null, summary: null,
  },
  driverApplication: { session: null, submission: null },
  safety: { requestedAt: null, requestedBy: null, requestNote: null, verification: null },
  sendToSafety: { ready: false, alreadyRequested: false, checks: [] },
  hire: { ready: false, missing: ['Safety approval'], hiredAt: null, driverId: null, employeeId: null },
  journeyState: { consent: 'none', safety: null, applicationReviewed: false, onboardingStarted: false, hireReady: false, onHold: false, consentFirst: true },
  permissions: { canManage: true, canSeeSensitive: true, canReassign: true },
  ...over,
});

/** The journey read the candidate page makes (owner brief, 2026-10-11): nothing started yet. */
const journey = {
  consent: { session: null, submission: null, clearinghouseAvailable: false, emailAvailable: false },
  deliveries: {
    channels: {
      sms: { available: false, via: null, reason: 'SMS is not set up: no Twilio account in Settings › Integrations.' },
      email: { available: false, via: null, reason: 'Email is not set up on this TMS.' },
    },
    items: [],
    sms: { phone: null, status: 'none', optedInAt: null, optedInBy: null, optedInSource: null, optedOutAt: null, optedOutSource: null },
  },
  safety: { review: null, authorizations: [], reports: [], checks: [], canDecide: false, canUpload: false },
  application: { canSend: false, blockedReason: 'The application is sent after the consent is signed and Safety approves it.', reviewedAt: null, reviewedBy: null, inheritedFromConsent: false },
  onboarding: { startedAt: null, startedBy: null, tasks: [] },
  travel: [],
  costs: { entries: [], summary: { spent: 0, planned: 0, approved: 0, paid: 0, companyCost: 0, driverCost: 0 } },
  hire: { ready: false, items: [], onHold: null, hired: null },
  permissions: { canManage: true, canSafety: false, canAccounting: false, canSeeSensitive: false },
};

let calls: { method: string; path: string; search: URLSearchParams; body: unknown }[] = [];
let rows: RecruitRow[] = [];
let notes: RecruitNote[] = [];
let failNote = false;
let current: RecruitCandidate = candidate();
const original = globalThis.fetch;

beforeEach(() => {
  calls = [];
  rows = [row({}), row({ key: 'apl_2', leadId: null, caseId: 'c2', applicantId: 'apl_2', name: 'Sonia Fennimore', progress: 'application_sent', stage: 'application_pending', nextStep: 'Waiting for application', followUpOn: '2026-10-09', followUpState: 'upcoming', lastNote: { text: 'No answer, will call back tomorrow', byName: 'Marina Valentine', at: '2026-10-08T18:00:00.000Z' } })];
  notes = [{ id: 'n1', at: '2026-10-08T14:14:00.000Z', byName: 'Grace Harper', kind: 'note', text: 'Spoke with Cameron on Instagram.', summary: null, followUpOn: null }];
  failNote = false;
  current = candidate();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ method, path, search: url.searchParams, body });
    const reply = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/hiring/recruiting/metrics') return reply(metrics);
    if (path === '/hiring/recruiting/candidates') return reply(list(rows));
    if (path === '/hiring/recruiting/recruiters') return reply([{ employeeId: 'emp_1148', name: 'Grace Harper' }, { employeeId: 'emp_1057', name: 'Marina Valentine' }]);
    if (path === '/hiring/recruiting/candidates/lead_1') return reply(current);
    if (path === '/hiring/recruiting/candidates/lead_1/journey') return reply(journey);
    if (path === '/hiring/recruiting/candidates/lead_1/notes' && method === 'GET') return reply(notes);
    if (path === '/hiring/recruiting/candidates/lead_1/notes' && method === 'POST') {
      if (failNote) return reply({ title: 'Service Unavailable', status: 503, detail: 'The database is not answering.' }, 503);
      const saved: RecruitNote = { id: 'n2', at: '2026-10-08T15:00:00.000Z', byName: 'Grace Harper', kind: 'note', text: body.note, summary: null, followUpOn: body.followUpOn };
      notes = [saved, ...notes];
      return reply(saved, 201);
    }
    if (path === '/hiring/recruiting/candidates/lead_1/name' && method === 'PATCH') {
      if (body.version !== current.version) return reply({ title: 'Conflict', status: 409, detail: 'This candidate changed since you opened it.' }, 409);
      current = candidate({ name: `${body.firstName} ${body.lastName}`.trim(), firstName: body.firstName, lastName: body.lastName, version: '2.-' });
      return reply({ candidate: current, driverNotice: null });
    }
    if (path === '/hiring/leads/lead_1/contacted' && method === 'POST') {
      current = candidate({ progress: 'contacted', nextStep: 'Send consent', lead: { status: 'contacted', prequalified: false, prequalFailed: null, deadReason: null } });
      return reply({ id: 'lead_1', status: 'contacted' }, 201);
    }
    if (path === '/hiring/recruiting/candidates/lead_1/driver-application/session' && method === 'POST') {
      return reply({ url: 'https://neway.example.com/application/#token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde', expiresAt: '2026-10-22T15:00:00.000Z', key: 'lead_1', session: { id: 'aps_1', state: 'live', createdAt: '2026-10-08T15:00:00.000Z', createdByName: 'Grace Harper', expiresAt: '2026-10-22T15:00:00.000Z', revokedAt: null, revokedBy: null, linkCopiedAt: null, linkCopiedBy: null, markedSentAt: null, markedSentBy: null, markedSentChannel: null, submittedAt: null } }, 201);
    }
    if (path === '/hiring/recruiting/candidates/lead_1/driver-application/session/copied') {
      return reply({ ...{ id: 'aps_1', state: 'live', createdAt: '2026-10-08T15:00:00.000Z', createdByName: 'Grace Harper', expiresAt: '2026-10-22T15:00:00.000Z', revokedAt: null, revokedBy: null, linkCopiedAt: null, linkCopiedBy: null, markedSentAt: null, markedSentBy: null, markedSentChannel: null, submittedAt: null }, linkCopiedAt: '2026-10-08T15:01:00.000Z', linkCopiedBy: 'Grace Harper' });
    }
    if (path === '/hiring/recruiting/candidates/lead_1/driver-application/session/mark-sent') {
      return reply({ ...{ id: 'aps_1', state: 'live', createdAt: '2026-10-08T15:00:00.000Z', createdByName: 'Grace Harper', expiresAt: '2026-10-22T15:00:00.000Z', revokedAt: null, revokedBy: null, linkCopiedAt: null, linkCopiedBy: null, markedSentAt: null, markedSentBy: null, markedSentChannel: null, submittedAt: null }, linkCopiedAt: '2026-10-08T15:01:00.000Z', markedSentAt: '2026-10-08T15:02:00.000Z', markedSentBy: 'Grace Harper', markedSentChannel: body.channel });
    }
    if (path === '/hiring/recruiting/candidates/lead_1/application-link') {
      return reply({ url: 'https://neway.example.com/dot/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde', expiresAt: '2026-10-22T15:00:00.000Z', key: 'apl_9', externalUrl: null, link: {} }, 201);
    }
    return inner(input, init);
  }) as typeof fetch;
  Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
  Object.defineProperty(navigator, 'clipboard', { value: { writeText: async () => undefined }, configurable: true });
});
afterEach(() => {
  globalThis.fetch = original;
});

describe('Candidate notes', () => {
  it('saves a note with its follow-up date, and keeps the text when the save fails', async () => {
    const user = userEvent.setup();
    renderPage(<RecruitCandidatePage candidateKey="lead_1" />, { path: '/?tab=notes' });
    await screen.findByTestId('notes-timeline');
    const box = screen.getByLabelText('Write a note');
    failNote = true;
    await user.type(box, 'Left a voicemail');
    await user.click(screen.getByTestId('save-note'));
    expect(await screen.findByText('The note was not saved')).toBeVisible();
    expect(box).toHaveValue('Left a voicemail');
    failNote = false;
    await user.click(screen.getByTestId('save-note'));
    await waitFor(() => expect(box).toHaveValue(''));
    const post = calls.filter((c) => c.method === 'POST' && c.path.endsWith('/notes')).at(-1);
    expect(post?.body).toEqual({ note: 'Left a voicemail', followUpOn: null });
    expect(await screen.findByText('Left a voicemail')).toBeVisible();
  });
});

describe('Copy application link', () => {
  it('makes the real link and copies it, without claiming it was sent', async () => {
    const user = userEvent.setup();
    renderPage(<CopyLinkModal candidate={candidate()} onClose={() => {}} />);
    await user.click(await screen.findByTestId('make-link'));
    const input = await screen.findByTestId('application-link-url');
    expect(input).toHaveValue('https://neway.example.com/dot/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde');
    await user.click(screen.getByTestId('copy-link-button'));
    expect(await screen.findAllByText('Link copied')).not.toHaveLength(0);
    const dialog = screen.getByTestId('copy-link-dialog');
    expect(dialog).not.toHaveTextContent(/\bsent to\b|has been sent|was sent/i);
    // The status is still the candidate's real progress: copying changed nothing.
    expect(within(dialog).getByTestId('progress-badge')).toHaveTextContent('New');
    // Copying is not sending: the only write was making the link.
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/hiring/recruiting/candidates/lead_1/application-link']);
  });
});

describe('Send application', () => {
  it('makes the personal link, copies it (recorded as copied, not sent), and marks it sent only when asked', async () => {
    const user = userEvent.setup();
    renderPage(<SendApplicationModal candidate={candidate()} onClose={() => {}} />);
    await user.click(await screen.findByTestId('make-link'));
    const input = await screen.findByTestId('application-link-url');
    expect(input).toHaveValue('https://neway.example.com/application/#token=AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde');
    expect(screen.getByTestId('driver-message')).toHaveTextContent('Hi Cameron! This is Grace from NORTHWIND FREIGHT recruiting.');
    expect(screen.getByTestId('status-sent')).toHaveTextContent('Not marked as sent');
    await user.click(screen.getByTestId('copy-link-button'));
    await waitFor(() => expect(screen.getByTestId('status-copied')).toHaveTextContent(/Link copied/));
    // Copying is not sending: still not marked as sent, and the dialog never says it was sent.
    expect(screen.getByTestId('status-sent')).toHaveTextContent('Not marked as sent');
    expect(screen.getByTestId('send-application-dialog')).not.toHaveTextContent(/has been sent|was sent to/i);
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      '/hiring/recruiting/candidates/lead_1/driver-application/session',
      '/hiring/recruiting/candidates/lead_1/driver-application/session/copied',
    ]);
    await user.click(screen.getByTestId('mark-sent'));
    await waitFor(() => expect(screen.getByTestId('status-sent')).toHaveTextContent(/Marked as sent/));
    expect(calls.at(-1)?.body).toEqual({ channel: 'Text message' });
  });
});

describe('Application received through the personal link', () => {
  const submission: DriverApplicationSubmissionView = {
    id: 'dapp_1',
    reference: 'APP-7K2Q9M4X',
    receivedAt: '2026-10-08T16:00:00.000Z',
    via: 'same_origin',
    schemaVersion: 'nwf-application-v1',
    answers: [
      { key: 'firstName', label: 'First name', value: 'Cameron' },
      { key: 'cdlClass', label: 'CDL class', value: 'Class A' },
    ],
    ssnMasked: '•••-••-6789',
    files: [
      { id: 'f1', code: 'cdl', label: 'CDL — front', fileName: 'cdl.jpg', contentType: 'image/jpeg', sizeBytes: 1048576, uploadedAt: '2026-10-08T16:00:00.000Z', documentId: 'doc_1', documentStatus: 'pending_review' },
    ],
    authorizations: [
      { type: 'mvr', label: 'MVR — driving record authorization', decision: 'signed', id: 'a1', signerName: 'Cameron Bolton', clientSignedAt: '2026-10-08T15:58:00.000Z', receivedAt: '2026-10-08T16:00:00.000Z', disclosureVersion: 'source-snapshot-2026-10-08', disclosureSha256: 'x', disclosureOpenedClaim: false, hasSignatureImage: true },
      { type: 'psp', label: 'PSP — pre-employment screening', decision: 'declined', id: 'a2', signerName: null, clientSignedAt: null, receivedAt: '2026-10-08T16:00:00.000Z', disclosureVersion: null, disclosureSha256: null, disclosureOpenedClaim: null, hasSignatureImage: false },
    ],
  };
  it('shows the answers with the SSN masked, the documents as waiting for Safety, and MVR and PSP separately', async () => {
    renderPage(<PersonalApplication candidate={candidate({ progress: 'application_received', driverApplication: { session: null, submission } })} />);
    expect(await screen.findByTestId('application-reference')).toHaveTextContent('APP-7K2Q9M4X');
    expect(screen.getByTestId('ssn-masked')).toHaveTextContent('•••-••-6789');
    expect(screen.getByTestId('application-file-cdl')).toHaveTextContent('Pending review');
    expect(screen.getByTestId('consent-mvr')).toHaveTextContent('Signed');
    expect(screen.getByTestId('consent-mvr')).toHaveTextContent('Cameron Bolton');
    expect(screen.getByTestId('consent-psp')).toHaveTextContent('Declined');
    expect(screen.getByText('Export signed MVR (PDF)')).toBeVisible();
  });
  it('the Documents tab panel shows the submitted driver application, sections and SSN masked', async () => {
    renderPage(<DriverApplicationPanel candidate={candidate({ progress: 'application_received', driverApplication: { session: null, submission } })} />);
    const panel = await screen.findByTestId('driver-application-panel');
    expect(panel).toHaveTextContent('APP-7K2Q9M4X');
    expect(panel).toHaveTextContent('Submitted');
    expect(panel).toHaveTextContent('Personal information');
    expect(panel).toHaveTextContent('CDL & experience');
    expect(panel).toHaveTextContent('•••-••-6789');
    expect(panel).not.toHaveTextContent('No application on file yet');
    expect(panel).toHaveTextContent('CDL — frontPending review');
    expect(panel).toHaveTextContent('MVRSigned · Cameron Bolton');
  });
});

describe('Hire', () => {
  it('is disabled with the real missing prerequisites listed', async () => {
    renderPage(<HireModal candidate={candidate({ progress: 'ready_to_hire', caseId: 'c1', hire: { ready: false, missing: ['Orientation attended', 'Road test passed'], hiredAt: null, driverId: 'drv_9', employeeId: null } })} onClose={() => {}} />);
    expect(await screen.findByText('Not ready to hire')).toBeVisible();
    expect(screen.getByText('Orientation attended')).toBeVisible();
    expect(screen.getByTestId('confirm-hire')).toBeDisabled();
  });
});

describe('Candidate status', () => {
  it('Mark as contacted moves the badge to Contacted without a reload', async () => {
    current = candidate({ progress: 'new', lead: { status: 'new', prequalified: false, prequalFailed: null, deadReason: null } });
    const user = userEvent.setup();
    renderPage(<RecruitCandidatePage candidateKey="lead_1" />);
    const badge = await screen.findByTestId('progress-badge');
    expect(badge).toHaveTextContent('New');
    await user.click(await screen.findByTestId('mark-contacted'));
    await waitFor(() => expect(screen.getByTestId('progress-badge')).toHaveTextContent('Contacted'));
    expect(calls.some((c) => c.method === 'POST' && c.path === '/hiring/leads/lead_1/contacted')).toBe(true);
  });

  it('the status badge lists every step; only real transitions are enabled', async () => {
    current = candidate({ progress: 'new', lead: { status: 'new', prequalified: false, prequalFailed: null, deadReason: null } });
    const user = userEvent.setup();
    renderPage(<RecruitCandidatePage candidateKey="lead_1" />);
    await user.click(await screen.findByTestId('status-menu'));
    expect(await screen.findByTestId('status-new')).toHaveAttribute('aria-current', 'step');
    expect(screen.getByTestId('status-contacted')).not.toHaveAttribute('data-disabled');
    expect(screen.getByTestId('status-application_received')).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('status-application_received')).toHaveTextContent('Set when the driver submits');
    expect(screen.getByTestId('status-consent_received')).toHaveTextContent('Set when the driver signs');
    expect(screen.getByTestId('status-ready_to_hire')).toHaveAttribute('data-disabled');
    expect(screen.getByTestId('status-closed')).toHaveTextContent('Disqualify');
    await user.click(screen.getByTestId('status-contacted'));
    await waitFor(() => expect(screen.getByTestId('progress-badge')).toHaveTextContent('Contacted'));
  });

  it('each note has a ⋯ menu that copies, and says notes are kept as written', async () => {
    const user = userEvent.setup();
    renderPage(<RecruitCandidatePage candidateKey="lead_1" />, { path: '/?tab=notes' });
    await screen.findByTestId('notes-timeline');
    await user.click(screen.getAllByTestId('note-menu')[0] as HTMLElement);
    expect(await screen.findByText('Copy text')).toBeVisible();
    expect(screen.getByText('Notes are kept as written')).toBeVisible();
  });

  it('shows the source icon and the assignee as a person, with the active tab underlined', async () => {
    renderPage(<RecruitCandidatePage candidateKey="lead_1" />);
    const card = await screen.findByTestId('contact-card');
    expect(within(card).getByTestId('source-icon-instagram')).toBeInTheDocument();
    expect(within(screen.getByTestId('assignee')).getByText('Grace')).toBeVisible();
    // One navigation: the nine journey steps as tabs, the open one underlined; Notes is a button beside them.
    expect(screen.getByRole('tab', { name: /Lead received/ }).className).toContain('border-nw-accent');
    expect(screen.getByRole('tab', { name: /Send consent/ }).className).toContain('border-transparent');
    expect(screen.queryByRole('tab', { name: 'Application' })).toBeNull();
    expect(screen.getByTestId('notes-button')).toBeVisible();
    // The lead's details appear once, in the candidate information card.
    expect(screen.getAllByText('Instagram').length).toBeGreaterThan(0);
  });
});

describe('Candidate name', () => {
  it('the pencil opens First / Last, Save sends them with the version, and the new name shows', async () => {
    const user = userEvent.setup();
    renderPage(<RecruitCandidatePage candidateKey="lead_1" />);
    expect(await screen.findByTestId('candidate-name')).toHaveTextContent('Cameron Bolton');
    await user.click(screen.getByTestId('edit-name'));
    const first = screen.getByLabelText('First name');
    const last = screen.getByLabelText('Last name');
    expect(first).toHaveValue('Cameron');
    expect(last).toHaveValue('Bolton');
    await user.clear(last);
    await user.type(last, 'Boltwood{Enter}');
    await waitFor(() => expect(screen.getByTestId('candidate-name')).toHaveTextContent('Cameron Boltwood'));
    const patch = calls.filter((c) => c.method === 'PATCH');
    expect(patch.map((c) => c.path)).toEqual(['/hiring/recruiting/candidates/lead_1/name']);
    expect(patch[0]?.body).toEqual({ firstName: 'Cameron', lastName: 'Boltwood', version: '1.-' });
    expect(screen.queryByTestId('edit-name-form')).toBeNull();
  });

  it('Escape cancels without saving, and Save button works too', async () => {
    const user = userEvent.setup();
    renderPage(<RecruitCandidatePage candidateKey="lead_1" />);
    await user.click(await screen.findByTestId('edit-name'));
    const first = screen.getByLabelText('First name');
    await user.clear(first);
    await user.type(first, 'Kameron');
    await user.keyboard('{Escape}');
    expect(screen.queryByTestId('edit-name-form')).toBeNull();
    expect(screen.getByTestId('candidate-name')).toHaveTextContent('Cameron Bolton');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    // Reopening starts from the stored name again, and Save sends it.
    await user.click(screen.getByTestId('edit-name'));
    expect(screen.getByLabelText('First name')).toHaveValue('Cameron');
    await user.clear(screen.getByLabelText('First name'));
    await user.type(screen.getByLabelText('First name'), 'Kameron');
    await user.click(screen.getByTestId('save-name'));
    await waitFor(() => expect(screen.getByTestId('candidate-name')).toHaveTextContent('Kameron Bolton'));
  });

  it('an empty first name is not sent, and a stale save says so', async () => {
    const user = userEvent.setup();
    renderPage(<RecruitCandidatePage candidateKey="lead_1" />);
    await user.click(await screen.findByTestId('edit-name'));
    await user.clear(screen.getByLabelText('First name'));
    await user.click(screen.getByTestId('save-name'));
    expect(screen.getByTestId('edit-name-error')).toHaveTextContent('Enter the first name.');
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    current = candidate({ version: '9.-' });
    await user.type(screen.getByLabelText('First name'), 'Kam');
    await user.click(screen.getByTestId('save-name'));
    expect(await screen.findByTestId('edit-name-error')).toHaveTextContent('changed since you opened it');
  });

  it('a viewer without manage sees no pencil', async () => {
    current = candidate({ permissions: { canManage: false, canSeeSensitive: false, canReassign: false } });
    renderPage(<RecruitCandidatePage candidateKey="lead_1" />);
    await screen.findByTestId('candidate-name');
    expect(screen.queryByTestId('edit-name')).toBeNull();
  });
});
