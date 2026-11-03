import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LeadNote, LeadRotation, MyLeadRow, MyLeads } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { RotationLine } from './LeadNotes';
import { MyLeadsTab } from './MyLeadsTab';

/**
 * My leads (owner, 2026-10-07): the signed-in recruiter's leads with their newest note, the
 * not-linked empty state, Add note, the notes history, and the read-only rotation line.
 */
const row = (over: Partial<MyLeadRow>): MyLeadRow => ({
  id: 'l1',
  leadNumber: 'LEAD-1001',
  name: 'Ann Driver',
  phone: '+13125550142',
  email: null,
  source: 'instagram',
  status: 'new',
  applicantId: null,
  createdAt: '2026-10-07T15:00:00.000Z',
  contactedAt: null,
  lastNote: null,
  ...over,
});
const note = (over: Partial<LeadNote>): LeadNote => ({
  id: 'n1',
  leadId: 'l1',
  at: '2026-10-07T16:00:00.000Z',
  byName: 'Grace Harper',
  kind: 'note',
  text: 'Call back at 3',
  summary: null,
  ...over,
});

let mine: MyLeads;
let notes: LeadNote[];
let posts: { path: string; body: unknown }[] = [];
const original = globalThis.fetch;

beforeEach(() => {
  posts = [];
  notes = [note({ id: 'n2', text: 'Sent job details', at: '2026-10-07T17:00:00.000Z' }), note({})];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    const reply = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (method !== 'GET') posts.push({ path, body });
    if (path === '/hiring/my-leads') return reply(mine);
    if (path === '/hiring/leads/l1/notes' && method === 'GET') return reply(notes);
    if (path === '/hiring/leads/l1/notes' && method === 'POST') {
      return reply(note({ id: 'n3', text: (body as { note: string }).note }), 201);
    }
    if (path === '/employees') return reply({ data: [], total: 0, page: 1, pageSize: 200 });
    if (path === '/hiring/lead-rotation') {
      const rotation: LeadRotation = {
        recruiters: [
          { employeeId: 'emp_1148', name: 'Grace Harper', since: '2026-10-07T16:53:43.000Z' },
          { employeeId: 'emp_1057', name: 'Marina Valentine', since: '2026-10-07T16:56:10.000Z' },
        ],
        next: { employeeId: 'emp_1057', name: 'Marina Valentine', since: '2026-10-07T16:56:10.000Z' },
        last: { employeeId: 'emp_1148', name: 'Grace Harper', at: '2026-10-07T18:00:00.000Z' },
      };
      return reply(rotation);
    }
    return inner(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

const render = (search: Record<string, string> = {}) =>
  renderPage(<MyLeadsTab search={search} update={() => {}} onOpenTab={() => {}} />, { routePath: '/', path: '/' });

describe('My leads', () => {
  it('says plainly when the account is not linked to a recruiter', async () => {
    mine = { recruiter: null, leads: [] };
    render();
    expect(await screen.findByText(/Ask an administrator to link it in Administration › Users/)).toBeVisible();
    expect(screen.queryByTestId('my-leads-table')).toBeNull();
  });

  it('lists the recruiter’s leads with status word, last note and next step', async () => {
    mine = {
      recruiter: { employeeId: 'emp_1148', name: 'Grace Harper', isRecruiter: true },
      leads: [
        row({ lastNote: note({ text: 'Sent job details' }) }),
        row({ id: 'l2', name: 'Ben Contacted', status: 'contacted', leadNumber: 'LEAD-1002' }),
      ],
    };
    render();
    const table = await screen.findByTestId('my-leads-table');
    expect(screen.getByText('Grace Harper’s leads')).toBeVisible();
    expect(within(table).getByText('Ann Driver')).toBeVisible();
    expect(within(table).getByText('New · needs contact')).toBeVisible();
    expect(within(table).getByText('Sent job details')).toBeVisible();
    expect(within(table).getByText('Call them, then mark contacted')).toBeVisible();
    expect(within(table).getByText('No notes yet')).toBeVisible();
    expect(within(table).getByText('Record the prequalification')).toBeVisible();
  });

  it('Add note saves the text as a note on that lead', async () => {
    mine = { recruiter: { employeeId: 'emp_1148', name: 'Grace Harper', isRecruiter: true }, leads: [row({})] };
    const user = userEvent.setup();
    render();
    const table = await screen.findByTestId('my-leads-table');
    await user.click(within(table).getByRole('button', { name: 'Add note' }));
    const dialog = await screen.findByTestId('add-note-dialog');
    const save = screen.getByRole('button', { name: 'Save' });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Note'), 'Left a voicemail');
    await user.click(save);
    await waitFor(() => expect(posts.some((p) => p.path === '/hiring/leads/l1/notes')).toBe(true));
    expect(posts.find((p) => p.path === '/hiring/leads/l1/notes')?.body).toEqual({ note: 'Left a voicemail' });
  });

  it('the lead detail shows the notes history newest first', async () => {
    mine = { recruiter: { employeeId: 'emp_1148', name: 'Grace Harper', isRecruiter: true }, leads: [row({})] };
    render({ lead: 'l1' });
    const history = await screen.findByTestId('lead-notes');
    await waitFor(() => expect(within(history).getByText('Sent job details')).toBeVisible());
    const items = within(history).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Sent job details');
    expect(items[1]).toHaveTextContent('Call back at 3');
    expect(items[0]).toHaveTextContent('Grace Harper');
  });
});

describe('Rotation line', () => {
  it('shows the turn order and who is next', async () => {
    renderPage(<RotationLine />, { routePath: '/', path: '/' });
    const line = await screen.findByTestId('lead-rotation');
    await waitFor(() => expect(line).toHaveTextContent('Grace Harper'));
    expect(line).toHaveTextContent('Marina Valentine');
    expect(line).toHaveTextContent('next: Marina Valentine');
  });
});
