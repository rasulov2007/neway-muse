import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { RtsBatchesPanel } from './RtsBatchesPanel';

/**
 * The RTS batches tab mounts, lists its batches, and the create dialog lets only an eligible
 * invoice be chosen while saying why the others cannot be.
 */
const open = () => renderPage(<RtsBatchesPanel />, { routePath: '/', path: '/' });

describe('RTS batches', () => {
  it('lists batches with their status in words that do not claim anything was sent', async () => {
    open();
    expect(await screen.findByText('RTS-00001')).toBeVisible();
    expect(screen.getByText('Exported · not sent')).toBeVisible();
  });

  it('a draft with nothing else against it can be selected and says it is issued with the batch', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Create RTS batch' }));
    const ok = await screen.findByTestId('rts-candidate-INV-20001');
    const draft = screen.getByTestId('rts-candidate-INV-20002');
    expect(within(ok).getByRole('checkbox')).toBeEnabled();
    expect(within(draft).getByRole('checkbox')).toBeEnabled();
    expect(within(draft).getByText(/Draft: issued when the batch is created/)).toBeVisible();
  });

  it('select all takes every invoice not yet sent, drafts included, and asks before issuing them', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Create RTS batch' }));
    await screen.findByTestId('rts-candidate-INV-20001');
    await user.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(within(screen.getByTestId('rts-candidate-INV-20001')).getByRole('checkbox')).toBeChecked();
    expect(within(screen.getByTestId('rts-candidate-INV-20002')).getByRole('checkbox')).toBeChecked();
    for (const row of screen.getAllByTestId(/^rts-candidate-/)) {
      if (row.getAttribute('data-eligible') === 'no') expect(within(row).getByRole('checkbox')).not.toBeChecked();
    }
    await user.click(screen.getByRole('button', { name: /^Create RTS batch \(/ }));
    expect(await screen.findByText(/and create the batch\?/)).toBeVisible();
  });

  it('shows the count, total and document state of the selection before anything is created', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Create RTS batch' }));
    await user.click(within(await screen.findByTestId('rts-candidate-INV-20001')).getByRole('checkbox'));
    const summary = screen.getByTestId('rts-selection-summary');
    expect(within(summary).getByText('1')).toBeVisible();
    expect(within(summary).getByText('$3,000.00')).toBeVisible();
    expect(within(summary).getByText('RC and POD on every invoice')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create RTS batch (1)' })).toBeEnabled();
  });
});
