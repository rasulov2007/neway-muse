import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { Textarea } from './Textarea';

describe('Textarea', () => {
  it('renders with rows and accepts typing', async () => {
    const user = userEvent.setup();
    render(<Textarea aria-label="Notes" rows={5} />);
    const textarea = screen.getByLabelText('Notes');
    expect(textarea).toHaveAttribute('rows', '5');
    await user.type(textarea, 'Deliver before noon');
    expect(textarea).toHaveValue('Deliver before noon');
  });

  it('exposes invalid state', () => {
    render(<Textarea aria-label="Notes" invalid />);
    expect(screen.getByLabelText('Notes')).toHaveAttribute('aria-invalid', 'true');
  });
});
