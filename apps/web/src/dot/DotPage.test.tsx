import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PublicDotApplication } from '@neway/shared';
import { ToastProvider, TooltipProvider } from '@/design-system';
import { tokenFromPath } from './api';
import { DotPage } from './DotPage';

/** The driver's page: an inactive link says so, steps save on Next, and the SSN is never echoed. */
const TOKEN = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQ';
const page = (over: Partial<PublicDotApplication> = {}): PublicDotApplication => ({
  companyName: 'NORTHWIND FREIGHT',
  firstName: 'Dana',
  lastName: 'Driver',
  form: null,
  hasSsn: false,
  ssnLast4: null,
  contact: { email: 'dana@example.com', phone: '+13125550100', location: 'IL' },
  sections: [],
  status: 'draft',
  certifiedAt: null,
  returnNote: null,
  returnedAt: null,
  updatedAt: null,
  cdlUploaded: false,
  cdlBackUploaded: false,
  cdlExpiresOn: null,
  expiresAt: '2026-10-21T14:00:00.000Z',
  ...over,
});

let answer: () => Response;
let puts: Record<string, unknown>[] = [];
const original = globalThis.fetch;
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  puts = [];
  answer = () => json(page());
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'PUT') {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      puts.push(body);
      return json(page({ form: body as never, hasSsn: Boolean(body.ssn), ssnLast4: body.ssn ? String(body.ssn).slice(-4) : null, updatedAt: '2026-10-07T19:12:00.000Z' }));
    }
    return answer();
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

const draw = () =>
  render(
    <TooltipProvider>
      <ToastProvider>
        <DotPage token={TOKEN} />
      </ToastProvider>
    </TooltipProvider>,
  );

describe('DOT application page', () => {
  it('reads the token from /dot/<token> only', () => {
    expect(tokenFromPath(`/dot/${TOKEN}`)).toBe(TOKEN);
    expect(tokenFromPath(`/dot/${TOKEN}/`)).toBe(TOKEN);
    expect(tokenFromPath('/apply/x')).toBe('');
  });

  it('says Loading… first, then that an expired or turned-off link is not active', async () => {
    answer = () => json({ detail: 'gone' }, 404);
    draw();
    expect(screen.getByText('Loading…')).toBeVisible();
    expect(await screen.findByTestId('dot-gone')).toHaveTextContent(
      'This link has expired or was turned off. Contact your recruiter for a new one.',
    );
  });

  it('opens on step 1 with the name filled in, saves on Next, and hides the SSN once saved', async () => {
    const user = userEvent.setup();
    draw();
    expect(await screen.findByTestId('dot-step-label')).toHaveTextContent('Step 1 of 6 · Personal information');
    expect(screen.getByTestId('dot-company')).toHaveTextContent('NORTHWIND FREIGHT');
    expect(screen.getByLabelText(/^First name/)).toHaveValue('Dana');
    await user.type(screen.getByLabelText('Social Security number'), '123-45-6789');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('dot-step-label')).toHaveTextContent('Step 2 of 6 · Address history'));
    expect(puts).toHaveLength(1);
    expect(puts[0]?.ssn).toBe('123-45-6789');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(screen.getByLabelText('Social Security number')).toHaveValue('');
    expect(screen.getByText(/SSN on file ••••6789/)).toBeVisible();
  });

  it("shows the recruiter's note when the application was returned", async () => {
    answer = () => json(page({ returnNote: 'Add your 2019 employer, please.', returnedAt: '2026-10-07T19:00:00.000Z' }));
    draw();
    expect(await screen.findByTestId('dot-return-note')).toHaveTextContent('Add your 2019 employer, please.');
  });

  it('after submitting, asks for the CDL; once it is in, says thank you', async () => {
    answer = () => json(page({ status: 'driver_submitted', certifiedAt: '2026-10-07T19:00:00.000Z' }));
    const { unmount } = draw();
    expect(await screen.findByTestId('dot-cdl')).toHaveTextContent('Upload your CDL');
    expect(screen.getByText('CDL expiry date')).toBeVisible();
    unmount();
    answer = () => json(page({ status: 'submitted', cdlUploaded: true }));
    draw();
    expect(await screen.findByTestId('dot-thanks')).toHaveTextContent('Thank you — your application is with our recruiting team.');
  });
});
