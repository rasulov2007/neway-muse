import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Input } from '../Input';
import { FormField } from './FormField';

describe('FormField', () => {
  it('links label, description and control', () => {
    render(
      <FormField label="Unit number" description="As printed on the door" required>
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText(/Unit number/);
    expect(input).toHaveAccessibleDescription('As printed on the door');
    expect(input).toHaveAttribute('aria-required', 'true');
    expect(input).not.toHaveAttribute('aria-invalid');
  });

  it('wires the error to the control', () => {
    render(
      <FormField label="VIN" error="VIN must be 17 characters">
        <Input />
      </FormField>,
    );
    const input = screen.getByLabelText('VIN');
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAccessibleDescription('VIN must be 17 characters');
    expect(screen.getByRole('alert')).toHaveTextContent('VIN must be 17 characters');
  });
});
