import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Button } from '../Button';
import { Input } from '../Input';
import { ControlledField, Form, FormActions, FormSection } from './Form';
import { useZodForm } from './useZodForm';

const schema = z.object({
  unit: z.string().min(1, 'Unit is required'),
  miles: z.coerce.number().min(0, 'Miles cannot be negative'),
});

function TruckForm({ onSubmit }: { onSubmit: (values: z.output<typeof schema>) => void }) {
  const form = useZodForm(schema, { defaultValues: { unit: '', miles: 0 } });
  return (
    <Form form={form} onSubmit={onSubmit}>
      <FormSection title="Identity" description="How the truck shows up in lists.">
        <ControlledField
          control={form.control}
          name="unit"
          label="Unit"
          required
          render={({ field }) => <Input {...field} />}
        />
        <ControlledField
          name="miles"
          label="Odometer"
          render={({ field }) => <Input type="number" {...field} />}
        />
      </FormSection>
      <FormActions>
        <Button type="submit" variant="primary">
          Save
        </Button>
      </FormActions>
    </Form>
  );
}

describe('Form helpers', () => {
  it('shows resolver errors and blocks submit', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TruckForm onSubmit={onSubmit} />);
    expect(screen.getByRole('heading', { name: 'Identity' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Unit is required')).toBeInTheDocument();
    expect(screen.getByLabelText(/Unit/)).toHaveAttribute('aria-invalid', 'true');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('submits parsed values when valid', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<TruckForm onSubmit={onSubmit} />);
    await user.type(screen.getByLabelText(/Unit/), '2785');
    await user.clear(screen.getByLabelText('Odometer'));
    await user.type(screen.getByLabelText('Odometer'), '120000');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toEqual({ unit: '2785', miles: 120000 });
  });
});
