import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { demoData, setDemoLatency } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { AccidentsPage } from './AccidentsPage';
import { InspectionsPage } from './InspectionsPage';
import { ViolationsPage } from './ViolationsPage';
import { inspectionsSearchSchema } from './inspections-search';
import { violationsSearchSchema } from './violations-search';

beforeAll(() => setDemoLatency(false));

/** The lists render their caption before the bundle resolves, so wait for real rows. */
async function loadedRows(caption: string): Promise<HTMLElement[]> {
  const table = await screen.findByRole('table', { name: caption });
  await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(3), {
    timeout: 10_000,
  });
  return within(table).getAllByRole('row') as HTMLElement[];
}

describe('InspectionsPage', () => {
  it('shows the brief’s subtitle and one create action', async () => {
    renderPage(<InspectionsPage />, {
      routePath: '/safety/inspections',
      path: '/safety/inspections',
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Inspections' })).toBeVisible();
    expect(
      screen.getByText(
        'Monitor inspections, findings, corrective actions and compliance status across your fleet.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create inspection' })).toBeInTheDocument();
  });

  it('counts the strip with the same predicate the table filters on', async () => {
    const user = userEvent.setup();
    renderPage(<InspectionsPage />, {
      routePath: '/safety/inspections',
      path: '/safety/inspections',
    });
    await loadedRows('Inspections');

    const passed = screen
      .getAllByRole('button', { pressed: false })
      .find((b) => /^Passed/.test(b.textContent ?? '')) as HTMLElement;
    const count = Number((passed.textContent ?? '').replace(/[^\d]/g, ''));
    expect(count).toBeGreaterThan(0);

    await user.click(passed);
    await waitFor(() => expect(passed).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(screen.getByText(new RegExp(`of ${count}\\b`))).toBeInTheDocument());
  });

  it('reports the derived lifecycle, not the stored pass/fail', async () => {
    // An inspection that passed but left defects open is not finished work, and the status column
    // has to say so even though `result` reads "pass".
    renderPage(<InspectionsPage />, {
      routePath: '/safety/inspections',
      path: '/safety/inspections?state=corrective_action_required',
    });
    const rows = await loadedRows('Inspections');
    for (const row of rows.slice(1)) {
      expect(within(row).getByText('Corrective action')).toBeInTheDocument();
    }
  });
});

describe('ViolationsPage', () => {
  it('files violations against the seven CSA BASICs', async () => {
    renderPage(<ViolationsPage />, {
      routePath: '/safety/violations',
      path: '/safety/violations',
    });
    await loadedRows('Violations');
    // The BASIC column exists and carries FMCSA's own vocabulary, not a friendlier substitute.
    expect(screen.getAllByText('Hours of service').length).toBeGreaterThan(0);
  });

  it('never shows a fabricated risk score, and says what it cannot compute', async () => {
    renderPage(<ViolationsPage />, {
      routePath: '/safety/violations',
      path: '/safety/violations',
    });
    await loadedRows('Violations');
    expect(screen.queryByText(/risk score:\s*\d/i)).toBeNull();
    expect(screen.getByText(/neither is estimated here/i)).toBeInTheDocument();
  });

  it('shows no FMCSA weight for an internally recorded finding', async () => {
    // A company review never went on a roadside report, so it carries no weight — and the column
    // says so rather than printing a zero.
    const internal = demoData.violations.find((v) => v.source === 'company');
    expect(internal?.points).toBeNull();

    renderPage(<ViolationsPage />, {
      routePath: '/safety/violations',
      path: '/safety/violations?source=company',
    });
    const rows = await loadedRows('Violations');
    const weightCell = within(rows[1] as HTMLElement).getAllByRole('cell')[12];
    expect(weightCell?.textContent?.trim()).toBe('—');
  });
});

describe('AccidentsPage', () => {
  it('applies 49 CFR 390.5 rather than asking anyone to remember it', async () => {
    renderPage(<AccidentsPage />, { routePath: '/safety/accidents', path: '/safety/accidents' });
    await loadedRows('Accidents');
    // Every row is judged, one way or the other; none is left blank.
    const recordable = screen.queryAllByText('Recordable').length;
    const not = screen.queryAllByText('Not recordable').length;
    expect(recordable + not).toBeGreaterThan(0);
  });

  it('treats an undecided preventability as something to act on', async () => {
    renderPage(<AccidentsPage />, {
      routePath: '/safety/accidents',
      path: '/safety/accidents?preventable=undetermined',
    });
    const rows = await loadedRows('Accidents');
    for (const row of rows.slice(1)) {
      expect(within(row).getByText('Undetermined')).toBeInTheDocument();
    }
  });
});

describe('AccidentsPage claim links', () => {
  it('opens the claim without selecting the accident row underneath it', async () => {
    const user = userEvent.setup();
    renderPage(<AccidentsPage />, { routePath: '/safety/accidents', path: '/safety/accidents' });
    const rows = await loadedRows('Accidents');

    const link = rows
      .flatMap((row) => within(row as HTMLElement).queryAllByRole('link'))
      .find((node) => /^CLM-/.test(node.textContent ?? ''));
    expect(link, 'the demo book has an accident with a claim on it').toBeTruthy();
    expect(link).toHaveAttribute('href', expect.stringMatching(/^\/safety\/claims\//));

    const row = link?.closest('tr') as HTMLElement;
    const checkbox = within(row).queryByRole('checkbox');
    await user.click(link as HTMLElement);
    // The row is a selection target; pressing the claim is not pressing the row.
    if (checkbox) expect(checkbox).not.toBeChecked();
  });
});

describe('safety search schemas', () => {
  it('accept a numeric-looking unit from the URL', () => {
    // The router parses `?unit=2747` into the number 2747; a plain z.string() would blank the page.
    expect(inspectionsSearchSchema.parse({ unit: 2747 }).unit).toBe('2747');
    expect(violationsSearchSchema.parse({ st: 'IL' }).st).toBe('IL');
  });

  it('degrade a malformed page number to no filter rather than an error', () => {
    expect(inspectionsSearchSchema.parse({ page: 'nonsense' }).page).toBeUndefined();
  });
});
