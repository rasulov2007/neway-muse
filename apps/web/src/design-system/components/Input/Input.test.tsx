import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Search } from 'lucide-react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { Input } from './Input';

describe('Input', () => {
  it('renders a text input, forwards the ref and accepts typing', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} placeholder="Unit number" onChange={onChange} />);
    const input = screen.getByPlaceholderText('Unit number');
    expect(ref.current).toBe(input);
    await user.type(input, '2785');
    expect(input).toHaveValue('2785');
    expect(onChange).toHaveBeenCalled();
  });

  it('marks invalid state with aria-invalid', () => {
    render(<Input aria-label="VIN" invalid />);
    expect(screen.getByLabelText('VIN')).toHaveAttribute('aria-invalid', 'true');
  });

  it('keeps the ref on the input when a prefix is present', () => {
    const ref = createRef<HTMLInputElement>();
    render(<Input ref={ref} aria-label="Search" prefix={<Search />} suffix="mi" disabled />);
    const input = screen.getByLabelText('Search');
    expect(ref.current).toBe(input);
    expect(input).toBeDisabled();
    expect(screen.getByText('mi')).toBeInTheDocument();
  });
});
