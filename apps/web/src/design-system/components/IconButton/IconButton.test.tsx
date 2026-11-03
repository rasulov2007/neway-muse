import { render, screen } from '@testing-library/react';
import { Plus } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('exposes the label as accessible name and native tooltip', () => {
    render(
      <IconButton label="Add truck">
        <Plus />
      </IconButton>,
    );
    const button = screen.getByRole('button', { name: 'Add truck' });
    expect(button).toHaveAttribute('title', 'Add truck');
    expect(button).toHaveAttribute('type', 'button');
  });

  it('is disabled while loading', () => {
    render(
      <IconButton label="Refresh" loading>
        <Plus />
      </IconButton>,
    );
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
  });
});
