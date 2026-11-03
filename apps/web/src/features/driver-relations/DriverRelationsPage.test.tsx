import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DRIVER_RELATION_TOPICS,
  type DriverRelationDetail,
  type DriverRelationRequest,
} from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { DriverRelationsPage } from './DriverRelationsPage';

/**
 * The Driver Relations page against a stubbed server: the red alert stays through an attempt and
 * goes only when a contact is recorded; a failed save keeps the note; a double click is one
 * request; an empty note never leaves the browser.
 */

const base = (over: Partial<DriverRelationRequest> = {}): DriverRelationRequest => ({
  id: 'r1',
  requestNumber: 'DR-1042',
  topic: 'management_call',
  topicLabel: 'Management Call Request',
  source: 'driver_care',
  status: 'new',
  needsContact: true,
  confidential: false,
  attachmentCount: 0,
  submittedName: 'Alex Morgan',
  truckNumber: '1189',
  contactPhone: '+13125550142',
  description: 'I would like to speak with management about my dispatch schedule.',
  payload: { callTopic: 'dispatch_work', callTopicLabel: 'Dispatch or work concern', preferredTime: 'After 3 PM Eastern' },
  driverId: null,
  driverName: null,
  truckId: null,
  truckUnit: null,
  assignedUserId: null,
  assignedUserName: null,
  receivedAt: '2026-10-06T14:24:00.000Z',
  lastDriverMessageAt: '2026-10-06T14:24:00.000Z',
  contactedAt: null,
  contactedByName: null,
  resolvedAt: null,
  resolvedByName: null,
  hrLeadId: null,
  hrLeadNumber: null,
  accountingExpenseId: null,
  version: 1,
  updatedAt: '2026-10-06T14:24:00.000Z',
  ...over,
});

let request: DriverRelationRequest;
let activities: DriverRelationDetail['activities'];
let posts: { path: string; body: Record<string, unknown> }[];
/** What the next contact POST does: answer, fail, or wait until released. */
let contactMode: 'ok' | 'fail' | 'hold';
let release: (() => void) | null;

let attachments: DriverRelationDetail['attachments'] = [];
let confidentialHidden = false;
const detail = (): DriverRelationDetail => ({ request, activities, deliveries: [], attachments });
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const original = globalThis.fetch;
beforeEach(() => {
  request = base();
  activities = [
    { id: 'a1', type: 'received', actorType: 'driver', actorName: 'Alex Morgan (Driver Care)', method: null, note: request.description, correctsActivityId: null, detail: null, at: request.receivedAt },
  ];
  posts = [];
  attachments = [];
  confidentialHidden = false;
  contactMode = 'ok';
  release = null;
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!path.startsWith('/driver-relations')) return inner(input, init);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (method === 'POST') posts.push({ path, body });

    if (path === '/driver-relations/counts') {
      const waiting = request.needsContact ? 1 : 0;
      return json({
        needsContact: waiting,
        byTopic: Object.fromEntries(DRIVER_RELATION_TOPICS.map((t) => [t, { needsContact: t === request.topic ? waiting : 0, total: t === request.topic ? 1 : 0 }])),
        byStatus: { awaitingContact: waiting, contacted: waiting ? 0 : 1, resolved: 0, all: 1 },
        confidentialHidden,
      });
    }
    if (path === '/driver-relations/requests') return json({ data: [request], total: 1, page: 1, pageSize: 25 });
    if (path === '/driver-relations/requests/r1') return json(detail());
    if (path === '/driver-relations/integration') return json({ telegram: { enabled: false, configured: false, label: 'Not connected' } });
    if (path === '/driver-relations/assignees') return json([{ userId: 'usr_dr', name: 'Dee Relations' }]);
    if (path === '/driver-relations/care-links') return json([]);
    if (path === '/driver-relations/requests/r1/attempts') {
      activities = [...activities, { id: `a${activities.length + 1}`, type: 'attempt', actorType: 'staff', actorName: 'System Administrator', method: 'phone', note: String(body.note), correctsActivityId: null, detail: null, at: '2026-10-06T15:00:00.000Z' }];
      return json(detail(), 201);
    }
    if (path === '/driver-relations/requests/r1/contact') {
      if (contactMode === 'fail') return json({ title: 'Service Unavailable', detail: 'The database is not answering.', status: 503 }, 503);
      if (contactMode === 'hold') await new Promise<void>((resolve) => (release = resolve));
      request = { ...request, needsContact: false, status: 'contacted', contactedAt: '2026-10-06T15:05:00.000Z', version: request.version + 1 };
      activities = [...activities, { id: `a${activities.length + 1}`, type: 'contacted', actorType: 'staff', actorName: 'System Administrator', method: 'phone', note: String(body.note), correctsActivityId: null, detail: null, at: '2026-10-06T15:05:00.000Z' }];
      return json(detail(), 201);
    }
    return json({ title: 'Not Found', detail: `stub has no ${method} ${path}`, status: 404 }, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

const open = () => renderPage(<DriverRelationsPage />, { routePath: '/driver-relations', path: '/driver-relations?request=r1' });

describe('Driver Relations page', () => {
  it('keeps the red alert through an attempt, and clears it only when contact is recorded', async () => {
    const user = userEvent.setup();
    open();
    expect(await screen.findByTestId('contact-alert')).toHaveTextContent('Alert stays until contact is recorded.');
    expect(within(screen.getByTestId('topic-management_call')).getByLabelText('1 needs contact')).toBeVisible();

    const note = screen.getByLabelText('Contact note (required)');
    await user.type(note, 'Tried calling, no answer');
    await user.click(screen.getByRole('button', { name: 'Record attempt' }));
    await waitFor(() => expect(posts.map((p) => p.path)).toContain('/driver-relations/requests/r1/attempts'));
    await waitFor(() => expect(screen.getByLabelText('Contact note (required)')).toHaveValue(''));
    expect(screen.getByTestId('contact-alert')).toBeVisible();

    await user.type(screen.getByLabelText('Contact note (required)'), 'Spoke with Alex; call set for Thursday.');
    await user.click(screen.getByRole('button', { name: 'Mark Contacted & save note' }));
    await waitFor(() => expect(screen.queryByTestId('contact-alert')).toBeNull());
    expect(posts.find((p) => p.path.endsWith('/contact'))?.body).toMatchObject({
      method: 'phone',
      note: 'Spoke with Alex; call set for Thursday.',
      expectedVersion: 1,
    });
    await waitFor(() => expect(within(screen.getByTestId('topic-management_call')).queryByLabelText(/needs contact/)).toBeNull());
  });

  it('refuses an empty note in the browser, and sends nothing', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByTestId('contact-alert');
    await user.type(screen.getByLabelText('Contact note (required)'), '   ');
    await user.click(screen.getByRole('button', { name: 'Mark Contacted & save note' }));
    expect(await screen.findByText('Write what was discussed before marking contacted.')).toBeVisible();
    expect(posts).toHaveLength(0);
  });

  it('keeps the typed note when the save fails, and keeps the alert', async () => {
    const user = userEvent.setup();
    contactMode = 'fail';
    open();
    await screen.findByTestId('contact-alert');
    const text = 'Spoke with Alex about the schedule.';
    await user.type(screen.getByLabelText('Contact note (required)'), text);
    await user.click(screen.getByRole('button', { name: 'Mark Contacted & save note' }));
    expect(await screen.findByText(/Not saved: The database is not answering\./)).toBeVisible();
    expect(screen.getByLabelText('Contact note (required)')).toHaveValue(text);
    expect(screen.getByTestId('contact-alert')).toBeVisible();
  });

  it('disables the buttons while a save is in flight, so a double click is one request', async () => {
    const user = userEvent.setup();
    contactMode = 'hold';
    open();
    await screen.findByTestId('contact-alert');
    await user.type(screen.getByLabelText('Contact note (required)'), 'Reached Alex.');
    const button = screen.getByRole('button', { name: 'Mark Contacted & save note' });
    await user.click(button);
    await user.click(button);
    await waitFor(() => expect(screen.getByRole('button', { name: /Mark Contacted & save note/ })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Record attempt' })).toBeDisabled();
    expect(posts.filter((p) => p.path.endsWith('/contact'))).toHaveLength(1);
    release?.();
    await waitFor(() => expect(screen.queryByTestId('contact-alert')).toBeNull());
    expect(posts.filter((p) => p.path.endsWith('/contact'))).toHaveLength(1);
  });

  it('lists receipts, and says plainly when confidential requests are hidden from this viewer', async () => {
    attachments = [
      { id: 'f1', fileName: 'lumper.png', contentType: 'image/png', sizeBytes: 20480, createdAt: request.receivedAt, url: '/api/v1/driver-relations/requests/r1/attachments/f1' },
    ];
    confidentialHidden = true;
    open();
    const list = await screen.findByRole('list', { name: 'Receipts' });
    expect(within(list).getByText('lumper.png')).toBeVisible();
    expect(within(list).getByRole('button', { name: 'Open' })).toBeVisible();
    expect(await screen.findByTestId('confidential-hidden')).toHaveTextContent('Driver Relations staff only');
  });

  it('says Telegram is not connected', async () => {
    open();
    expect(await screen.findByText('Telegram: Not connected')).toBeVisible();
  });
});
