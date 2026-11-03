import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { isSameDay, subDays } from 'date-fns';
import { useState, type FormEvent } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { parseDateInput } from './dateInput';
import { DatePicker } from './DatePicker';
import { DateRangePicker } from './DateRangePicker';

describe('DatePicker', () => {
  it('shows the formatted value and picks a day from the calendar', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <DatePicker aria-label="Pickup date" value={new Date(2026, 2, 5)} onChange={onChange} />,
    );
    const field = screen.getByRole('textbox', { name: 'Pickup date' });
    expect(field).toHaveValue('Mar 5, 2026');

    await user.click(screen.getByRole('button', { name: 'Open calendar' }));
    expect(await screen.findByRole('grid')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /March 12/ }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(isSameDay(onChange.mock.calls[0]?.[0] as Date, new Date(2026, 2, 12))).toBe(true);
  });

  it('shows the placeholder when empty', () => {
    render(<DatePicker aria-label="Delivery date" placeholder="Choose" />);
    expect(screen.getByRole('textbox', { name: 'Delivery date' })).toHaveAttribute(
      'placeholder',
      'Choose',
    );
  });

  it.each([
    ['09/11/2026', new Date(2026, 8, 11)],
    ['9/1/2026', new Date(2026, 8, 1)],
    ['9/1/26', new Date(2026, 8, 1)],
    ['2026-09-11', new Date(2026, 8, 11)],
    ['Sep 11 2026', new Date(2026, 8, 11)],
    ['Sep 11, 2026', new Date(2026, 8, 11)],
    ['September 11 2026', new Date(2026, 8, 11)],
    ['11 Sep 2026', new Date(2026, 8, 11)],
  ])('reads %s', (text, expected) => {
    const parsed = parseDateInput(text);
    expect(parsed).not.toBeNull();
    expect(isSameDay(parsed as Date, expected)).toBe(true);
  });

  it('accepts pasted text on blur and normalizes the display', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onIsoChange = vi.fn();
    render(
      <>
        <DatePicker aria-label="Issue date" onChange={onChange} onIsoChange={onIsoChange} />
        <button type="button">Elsewhere</button>
      </>,
    );
    const field = screen.getByRole('textbox', { name: 'Issue date' });
    await user.click(field);
    await user.paste('2026-09-11');
    expect(onChange).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Elsewhere' }));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(isSameDay(onChange.mock.calls[0]?.[0] as Date, new Date(2026, 8, 11))).toBe(true);
    expect(onIsoChange).toHaveBeenCalledWith('2026-09-11');
  });

  it('shows the value in the app format once the caller stores it', async () => {
    const user = userEvent.setup();
    function Harness() {
      const [iso, setIso] = useState('');
      return <DatePicker aria-label="Expiry date" value={iso} onIsoChange={setIso} />;
    }
    render(<Harness />);
    const field = screen.getByRole('textbox', { name: 'Expiry date' });
    await user.type(field, '9/11/2026{Enter}');
    expect(field).toHaveValue('Sep 11, 2026');
    expect(field).not.toHaveAttribute('aria-invalid');
  });

  it('commits typed text on Enter without submitting the form', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onSubmit = vi.fn((event: FormEvent) => event.preventDefault());
    render(
      <form onSubmit={onSubmit}>
        <DatePicker aria-label="Hire date" onChange={onChange} />
        <button type="submit">Save</button>
      </form>,
    );
    await user.type(screen.getByRole('textbox', { name: 'Hire date' }), 'Sep 11, 2026{Enter}');
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(isSameDay(onChange.mock.calls[0]?.[0] as Date, new Date(2026, 8, 11))).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('keeps unreadable text and says what to enter', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DatePicker aria-label="Due date" onChange={onChange} />);
    const field = screen.getByRole('textbox', { name: 'Due date' });
    await user.type(field, 'next tuesday{Enter}');
    expect(onChange).not.toHaveBeenCalled();
    expect(field).toHaveValue('next tuesday');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    const message = screen.getByRole('alert');
    expect(message).toHaveTextContent('Enter a date like 09/11/2026');
    expect(field.getAttribute('aria-describedby')).toContain(message.id);

    // Fixing the text lifts the message.
    await user.clear(field);
    await user.type(field, '09/11/2026{Enter}');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('clears the value when the text is emptied', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DatePicker aria-label="End date" value="2026-09-11" onChange={onChange} />);
    const field = screen.getByRole('textbox', { name: 'End date' });
    expect(field).toHaveValue('Sep 11, 2026');
    await user.clear(field);
    await user.tab();
    expect(onChange).toHaveBeenCalledWith(undefined);
  });

  it('submits ISO through the hidden input', () => {
    render(<DatePicker aria-label="Start" name="startsOn" value={new Date(2026, 0, 2)} />);
    expect(document.querySelector('input[name="startsOn"]')).toHaveValue('2026-01-02');
  });
});

describe('DateRangePicker', () => {
  it('applies a preset', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<DateRangePicker aria-label="Period" onChange={onChange} />);
    await user.click(screen.getByRole('button', { name: /Period/ }));
    await user.click(await screen.findByRole('button', { name: 'Last 7 days' }));
    const range = onChange.mock.calls[0]?.[0] as { from: Date; to: Date };
    expect(isSameDay(range.from, subDays(new Date(), 6))).toBe(true);
    expect(isSameDay(range.to, new Date())).toBe(true);
  });

  it('formats a range in the trigger', () => {
    render(
      <DateRangePicker
        aria-label="Period"
        value={{ from: new Date(2026, 0, 1), to: new Date(2026, 0, 31) }}
      />,
    );
    expect(screen.getByRole('button', { name: /Period/ })).toHaveTextContent(
      'Jan 1, 2026 – Jan 31, 2026',
    );
  });
});
