import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Radio, RadioGroup } from './Radio';

const options = [
  { value: 'company', label: 'Company driver' },
  { value: 'owner', label: 'Owner operator', description: 'Paid per mile' },
];

describe('RadioGroup', () => {
  it('renders options and reports selection', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<RadioGroup label="Driver type" options={options} onValueChange={onValueChange} />);
    expect(screen.getByRole('radiogroup', { name: 'Driver type' })).toBeInTheDocument();
    await user.click(screen.getByText('Owner operator'));
    expect(onValueChange).toHaveBeenCalledWith('owner');
    expect(screen.getByRole('radio', { name: 'Owner operator' })).toHaveAccessibleDescription(
      'Paid per mile',
    );
  });

  it('supports composition with a default value', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <RadioGroup label="Fuel" defaultValue="diesel" onValueChange={onValueChange}>
        <Radio value="diesel" label="Diesel" />
        <Radio value="gas" label="Gas" />
      </RadioGroup>,
    );
    expect(screen.getByRole('radio', { name: 'Diesel' })).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByRole('radio', { name: 'Gas' }));
    expect(onValueChange).toHaveBeenCalledWith('gas');
    expect(screen.getByRole('radio', { name: 'Gas' })).toHaveAttribute('aria-checked', 'true');
  });
});
