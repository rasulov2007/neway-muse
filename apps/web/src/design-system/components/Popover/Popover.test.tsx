import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Popover, PopoverContent, PopoverTrigger } from './Popover';

describe('Popover', () => {
  it('opens on click and closes on Escape', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger asChild>
          <button type="button">Filters</button>
        </PopoverTrigger>
        <PopoverContent>Filter options</PopoverContent>
      </Popover>,
    );
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(await screen.findByText('Filter options')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByText('Filter options')).not.toBeInTheDocument();
  });
});
