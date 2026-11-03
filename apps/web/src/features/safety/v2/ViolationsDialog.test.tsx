import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ToastProvider } from '@/design-system/components/Toast';
import { groupViolationCases, violationCaseSummary, type SafetyViolation } from '@neway/shared';

const post = vi.fn();
const attach = vi.fn();

vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>();
  return {
    ...real,
    useSafetyPickers: () => ({ data: { drivers: [{ id: 'drv_1', name: 'Percy Pellerin' }], trucks: [{ id: 'trk_1', number: '0039' }] }, isLoading: false }),
    useRoadsideInspections: () => ({ data: [], isLoading: false }),
    safetyApi: { ...real.safetyApi, post: (...args: unknown[]) => post(...args), attach: (...args: unknown[]) => attach(...args) },
  };
});

const { AddViolationDialog, DeleteViolationDialog } = await import('./ViolationsPage');

describe('Delete (owner, 2026-10-21)', () => {
  it('names the case and its count, asks for a reason, and says it is kept on record', async () => {
    const onDelete = vi.fn();
    render(<DeleteViolationDialog open onOpenChange={() => undefined} what="Report TNI000000001" count={3} onDelete={onDelete} />);
    expect(screen.getByText('Delete this case? (3 violations)')).toBeTruthy();
    expect(screen.getByText(/kept on record/)).toBeTruthy();
    const confirm = screen.getByTestId('confirm-delete');
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByRole('textbox', { name: 'Reason' }), 'Entered twice');
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
    await userEvent.click(confirm);
    expect(onDelete).toHaveBeenCalledWith('Entered twice');
  });

  it('asks about one violation when no count is given', () => {
    render(<DeleteViolationDialog open onOpenChange={() => undefined} what="V-008" onDelete={() => undefined} />);
    expect(screen.getByText('Delete this violation?')).toBeTruthy();
  });
});

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AddViolationDialog open onOpenChange={() => undefined} kind="inspection" />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Add inspection (owner, 2026-10-21)', () => {
  beforeEach(() => {
    post.mockReset();
    attach.mockReset();
  });

  it('puts Rule / code first, then Violation, then Category, in every violation block', async () => {
    renderDialog();
    await userEvent.click(screen.getByTestId('add-violation-line'));
    for (const i of [0, 1]) {
      const block = screen.getByTestId(`violation-block-${i}`);
      const labels = within(block)
        .getAllByText(/^(Rule \/ code|Violation( \d)?|Category)$/)
        .map((el) => el.textContent?.replace(/\s*\*$/, '').replace(/ \d$/, ''));
      expect(labels).toEqual(['Rule / code', 'Violation', 'Category']);
      const code = within(block).getByTestId(`violation-code-${i}`);
      const what = within(block).getByTestId(`violation-line-${i}`);
      expect(code.compareDocumentPosition(what) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  it('asks for the State from a searchable list instead of the issuing agency, and saves one case', async () => {
    post.mockResolvedValue({ id: 'vcs_1', leadId: 'vio_1', number: 'V-010', violations: [{}, {}] });
    renderDialog();
    expect(screen.queryByText('Issuing agency')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'State' }));
    await userEvent.type(screen.getByPlaceholderText('Type a code or a name…'), 'tenn');
    const options = await screen.findAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['TN — Tennessee']);
    await userEvent.click(options[0]!);

    await userEvent.type(screen.getByTestId('violation-code-0'), '392.9A2-C');
    await userEvent.type(screen.getByTestId('violation-line-0'), 'Failing to secure load');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Violation 1 out of service' }));
    await userEvent.click(screen.getByTestId('add-violation-line'));
    await userEvent.type(screen.getByTestId('violation-code-1'), '393.47E');
    await userEvent.type(screen.getByTestId('violation-line-1'), 'Brake out of adjustment');
    await userEvent.click(screen.getByTestId('add-violation-save'));

    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/violation-cases');
    expect(body.state).toBe('TN');
    expect(body).not.toHaveProperty('agency');
    expect(body.lines).toEqual([
      { code: '392.9A2-C', description: 'Failing to secure load', category: null, oos: true },
      { code: '393.47E', description: 'Brake out of adjustment', category: null, oos: false },
    ]);
  });

  it('records "Issued to" as Driver and Carrier when both are ticked (owner, 2026-10-24)', async () => {
    post.mockResolvedValue({ id: 'vcs_2', leadId: 'vio_2', number: 'V-011', violations: [{}] });
    renderDialog();
    const driver = screen.getByRole('checkbox', { name: 'Driver' });
    const carrier = screen.getByRole('checkbox', { name: 'Carrier' });
    expect(driver.getAttribute('aria-checked') ?? String((driver as HTMLInputElement).checked)).toBe('true');
    await userEvent.click(carrier);
    expect(screen.getByText('Issued to: Driver and Carrier')).toBeTruthy();
    await userEvent.type(screen.getByTestId('violation-line-0'), 'Brake out of adjustment');
    await userEvent.click(screen.getByTestId('add-violation-save'));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0] as [string, Record<string, unknown>])[1].issuedTo).toBe('both');
  });

  it('cannot save an inspection with neither party ticked', async () => {
    renderDialog();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Driver' }));
    await userEvent.type(screen.getByTestId('violation-line-0'), 'Brake out of adjustment');
    expect(screen.getByText('Tick one or both')).toBeTruthy();
    expect((screen.getByTestId('add-violation-save') as HTMLButtonElement).disabled).toBe(true);
  });
});

describe('one paper, one case', () => {
  const v = (over: Partial<SafetyViolation>): SafetyViolation =>
    ({ id: 'x', caseId: null, number: 'V-1', createdAt: '2026-10-19T16:00:00Z', occurredAt: '2026-10-19T16:00:00Z', code: null, description: 'd', oos: false, status: 'undecided', closedAt: null, openTracks: [], notes: [], moneyKind: null, moneyCents: null, isTest: false, ...over }) as SafetyViolation;

  it('reads three violations as one line', () => {
    expect(
      violationCaseSummary([v({ code: '392.9A2-C', oos: true }), v({ code: '393.47E' }), v({ code: '393.53B-B' })]),
    ).toBe('3 violations: 392.9A2-C (OOS), 393.47E, 393.53B-B');
  });

  it('folds rows that share a case id into one case led by the first recorded', () => {
    const cases = groupViolationCases([
      v({ id: 'b', caseId: 'vcs_1', number: 'V-2', createdAt: '2026-10-19T16:00:01Z' }),
      v({ id: 'a', caseId: 'vcs_1', number: 'V-1' }),
      v({ id: 'c', number: 'V-3' }),
    ]);
    expect(cases.map((c) => [c.id, c.leadId, c.violations.length])).toEqual([
      ['vcs_1', 'a', 2],
      ['c', 'c', 1],
    ]);
  });
});
