import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Tooltip, TooltipProvider } from './Tooltip';

describe('Tooltip', () => {
  it('shows content on hover', async () => {
    const user = userEvent.setup();
    render(
      <TooltipProvider delayDuration={0}>
        <Tooltip content="Edit truck">
          <button type="button">Edit</button>
        </Tooltip>
      </TooltipProvider>,
    );
    await user.hover(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('Edit truck');
  });

  it('renders the child alone when content is empty', () => {
    render(
      <TooltipProvider>
        <Tooltip content="">
          <button type="button">Plain</button>
        </Tooltip>
      </TooltipProvider>,
    );
    expect(screen.getByRole('button', { name: 'Plain' })).not.toHaveAttribute('data-state');
  });
});
