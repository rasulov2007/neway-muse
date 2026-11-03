import { screen, waitFor } from '@testing-library/dom';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import html from '../../care.html?raw';

/**
 * The approved Driver Care design in a browser-like DOM, against a stubbed server: the six cards
 * in the design's order; the brief's field rules; "received" only after a 201; a failure keeps
 * every answer; a double tap is one POST; a retry reuses the submission id; receipts ride along;
 * no drafts, nothing stored in the browser.
 */

const bodyHtml = /<body>([\s\S]*)<\/body>/.exec(html)?.[1]?.replace(/<script[\s\S]*?<\/script>/g, '') ?? '';

let posts: Record<string, unknown>[];
let mode: 'ok' | 'fail' | 'hold' | 'invalid';
let release: (() => void) | null;
const original = globalThis.fetch;
const storageKeys = () => [...Object.keys(window.localStorage), ...Object.keys(window.sessionStorage)].sort();
let storageBefore: string[];

beforeEach(async () => {
  posts = [];
  mode = 'ok';
  release = null;
  document.body.innerHTML = bodyHtml;
  document.documentElement.dataset.careSlug = 'nwf';
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    expect(url).toContain('/api/v1/public/driver-care/nwf');
    expect(init?.credentials).toBe('omit');
    if ((init?.method ?? 'GET') === 'GET') {
      return new Response(JSON.stringify({ companyName: 'NORTHWIND FREIGHT INC', displayName: 'NORTHWIND FREIGHT INC' }), { status: 200 });
    }
    posts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    if (mode === 'fail') return new Response(JSON.stringify({ title: 'Service Unavailable', status: 503 }), { status: 503 });
    if (mode === 'invalid') {
      return new Response(JSON.stringify({ status: 422, errors: [{ path: 'phone', message: 'Enter a valid 10-digit phone number.' }] }), {
        status: 422,
      });
    }
    if (mode === 'hold') await new Promise<void>((resolve) => (release = resolve));
    return new Response(JSON.stringify({ status: 'received', reference: 'DR-1042' }), { status: 201 });
  }) as typeof fetch;
  storageBefore = storageKeys();
  vi.resetModules();
  await import('./main');
  await waitFor(() => expect(document.getElementById('home')!.hidden).toBe(false));
});

afterEach(() => {
  globalThis.fetch = original;
  delete document.documentElement.dataset.careSlug;
});

const fill = async (user: ReturnType<typeof userEvent.setup>, label: string | RegExp, value: string) => {
  const field = screen.getByLabelText(label);
  await user.clear(field);
  await user.type(field, value);
};
const card = (name: RegExp) => screen.getByRole('button', { name });
const pick = async (user: ReturnType<typeof userEvent.setup>, trigger: RegExp, option: string) => {
  await user.click(screen.getByRole('button', { name: trigger }));
  await user.click(screen.getByRole('option', { name: option }));
};

describe('NORTHWIND FREIGHT Driver Care (approved design)', () => {
  it('shows the six services in the design’s order, the $900 referral bonus, and no drafts anywhere', () => {
    const names = Array.from(document.querySelectorAll('.service h3')).map((n) => n.textContent);
    expect(names).toEqual(['Refer a Driver', 'Complaint & Feedback', 'Reimbursement', 'Pay & Statement Help', 'Compliance', 'Management Call Request']);
    expect(document.querySelector('.service .bonus')?.textContent).toBe('$900');
    expect(document.body.textContent).not.toMatch(/draft|not sent to TMS|Connection preview|My drafts/i);
    expect(document.querySelectorAll('#headline .letter').length).toBeGreaterThan(10);
  });

  it('referral asks exactly name, truck, referral name and referral phone', async () => {
    const user = userEvent.setup();
    await user.click(card(/Refer a Driver/));
    const visible = Array.from(document.querySelectorAll<HTMLInputElement>('#requestForm input, #requestForm textarea, #requestForm select')).filter(
      (el) => !el.hidden && el.name !== 'website',
    );
    expect(visible.map((el) => el.id)).toEqual(['driver', 'truck', 'phone', 'driverName']);
    expect(screen.getByText('Referral driver phone number')).toBeTruthy();
    await fill(user, 'Your name', 'Robin Hayes');
    await fill(user, 'Truck number', '9006');
    await fill(user, 'Referral driver phone number', '(312) 555-0142');
    await fill(user, 'Referral driver name', 'Jamie West');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByRole('heading', { name: 'Your request was received.' })).toBeTruthy();
    expect(screen.getByText('DR-1042')).toBeTruthy();
    expect(posts[0]).toMatchObject({ topic: 'referral', name: 'Robin Hayes', truckNumber: '9006', referralName: 'Jamie West', referralPhone: '(312) 555-0142' });
    expect(Object.keys(posts[0]!).sort()).toEqual(['name', 'referralName', 'referralPhone', 'submissionId', 'topic', 'truckNumber', 'website']);
    expect(storageKeys()).toEqual(storageBefore);
  });

  it('Pay & Statement Help has no topic dropdown: free text, optional week start and load number', async () => {
    const user = userEvent.setup();
    await user.click(card(/Pay & Statement Help/));
    expect(document.querySelector('#requestForm select')).toBeNull();
    expect(document.querySelector('.dropdown')).toBeNull();
    await fill(user, 'Your name', 'Jordan Lee');
    await fill(user, 'Truck number', '2309');
    await fill(user, 'Phone number', '(312) 555-0142');
    await fill(user, 'Load number (optional)', 'L-1008');
    await fill(user, 'How can we help?', 'Load missing from my statement');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await screen.findByRole('heading', { name: 'Your request was received.' });
    expect(posts[0]).toMatchObject({ topic: 'pay_statement', details: 'Load missing from my statement', loadNumber: 'L-1008', weekStart: null });
  });

  it('Management Call: centered, the company message, a topic dropdown and a requested time', async () => {
    const user = userEvent.setup();
    await user.click(card(/Management Call Request/));
    expect(document.getElementById('modal')!.classList.contains('management-call')).toBe(true);
    expect(document.getElementById('formIntro')!.textContent).toBe('NORTHWIND FREIGHT always cares about its drivers.');
    expect(screen.getByText(/a request, not a confirmed appointment/)).toBeTruthy();
    await fill(user, 'Your name', 'Alex Morgan');
    await fill(user, 'Truck number', '1189');
    await fill(user, 'Phone number', '(312) 555-0142');
    await pick(user, /What would you like to discuss/, 'Confidential concern');
    await fill(user, 'Preferred call time (optional)', 'Tomorrow 2-4 PM Central');
    await fill(user, 'How can we help?', 'About my dispatcher');
    await user.click(screen.getByRole('button', { name: 'Request a call' }));
    expect(await screen.findByRole('heading', { name: 'NORTHWIND FREIGHT always cares about its drivers.' })).toBeTruthy();
    expect(document.getElementById('savedText')!.textContent).toMatch(/not a confirmed appointment/);
    expect(posts[0]).toMatchObject({ topic: 'management_call', callTopic: 'confidential', preferredTime: 'Tomorrow 2-4 PM Central' });
  });

  it('the dropdown works from the keyboard', async () => {
    const user = userEvent.setup();
    await user.click(card(/Compliance/));
    const trigger = screen.getByRole('button', { name: /What do you need help with/ });
    trigger.focus();
    await user.keyboard('{ArrowDown}');
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowDown}{Enter}');
    expect((document.getElementById('documentType') as HTMLSelectElement).value).toBe('medical_card');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('keeps every answer when the save fails, and a retry is the same submission', async () => {
    const user = userEvent.setup();
    mode = 'fail';
    await user.click(card(/Complaint & Feedback/));
    await fill(user, 'Your name', 'Casey Brooks');
    await fill(user, 'Truck number', '0075');
    await fill(user, 'Phone number', '(312) 555-0142');
    await fill(user, 'How can we help?', 'Clearer updates please');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    expect(await screen.findByText(/could not be saved just now/)).toBeTruthy();
    expect(document.getElementById('saved')!.hidden).toBe(true);
    expect(screen.getByLabelText('How can we help?')).toHaveValue('Clearer updates please');
    mode = 'ok';
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await screen.findByRole('heading', { name: 'Your request was received.' });
    expect(posts).toHaveLength(2);
    expect(posts[1]!.submissionId).toBe(posts[0]!.submissionId);
  });

  it('puts the server’s message on the field it names', async () => {
    const user = userEvent.setup();
    mode = 'invalid';
    await user.click(card(/Complaint & Feedback/));
    await fill(user, 'Your name', 'Casey Brooks');
    await fill(user, 'Truck number', '0075');
    await fill(user, 'Phone number', '(312) 555-0142');
    await fill(user, 'How can we help?', 'x');
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await waitFor(() => expect(screen.getByLabelText('Phone number')).toHaveAttribute('aria-invalid', 'true'));
    expect((screen.getByLabelText('Phone number') as HTMLInputElement).validationMessage).toBe('Enter a valid 10-digit phone number.');
  });

  it('a double tap sends one request', async () => {
    const user = userEvent.setup();
    mode = 'hold';
    await user.click(card(/Compliance/));
    await fill(user, 'Your name', 'Chris Parker');
    await fill(user, 'Truck number', '0040');
    await fill(user, 'Phone number', '(312) 555-0142');
    await fill(user, 'How can we help?', 'Medical card');
    const send = screen.getByRole('button', { name: 'Send request' });
    await user.click(send);
    await user.click(send);
    expect(screen.getByRole('button', { name: 'Sending…' })).toBeDisabled();
    expect(posts).toHaveLength(1);
    release?.();
    await screen.findByRole('heading', { name: 'Your request was received.' });
    expect(posts).toHaveLength(1);
  });

  it('a reimbursement sends its receipts; more than three are refused in the page', async () => {
    const user = userEvent.setup();
    await user.click(card(/Reimbursement/));
    await fill(user, 'Your name', 'Sam Taylor');
    await fill(user, 'Truck number', '303');
    await fill(user, 'Phone number', '(312) 555-0142');
    await fill(user, 'Amount paid ($)', '85');
    await fill(user, 'How can we help?', 'Lumper');
    const input = document.getElementById('receipts') as HTMLInputElement;
    const png = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'lumper.png', { type: 'image/png' });
    await user.upload(input, png);
    expect(screen.getByText(/lumper\.png/)).toBeTruthy();
    await user.upload(input, [png, png, png]);
    expect(screen.getByText('Attach up to 3 files.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Send request' }));
    await screen.findByRole('heading', { name: 'Your request was received.' });
    const sent = posts[0] as { amount: number; attachments: { fileName: string; content: string }[] };
    expect(sent.amount).toBe(85);
    expect(sent.attachments).toHaveLength(1);
    expect(sent.attachments[0]!.fileName).toBe('lumper.png');
    expect(sent.attachments[0]!.content).toMatch(/^data:image\/png;base64,/);
  });

  it('checks required fields and the phone in the browser before sending', async () => {
    const user = userEvent.setup();
    await user.click(card(/Management Call Request/));
    await fill(user, 'Phone number', '123');
    await user.click(screen.getByRole('button', { name: 'Request a call' }));
    expect((screen.getByLabelText('Phone number') as HTMLInputElement).validationMessage).toBe('Enter a valid 10-digit phone number.');
    expect(posts).toHaveLength(0);
  });
});
