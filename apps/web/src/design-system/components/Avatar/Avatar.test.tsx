import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';
import { getInitials } from './initials';

describe('Avatar', () => {
  it('renders initials with the name as title and accessible name', () => {
    render(<Avatar name="Sarah Chen" />);
    const el = screen.getByRole('img', { name: 'Sarah Chen' });
    expect(el).toHaveAttribute('title', 'Sarah Chen');
    expect(el).toHaveTextContent('SC');
    expect(el).toHaveClass('size-8');
  });

  it('renders the image when src is given and falls back to initials on error', () => {
    const { container } = render(<Avatar name="Sarah Chen" src="/sarah.png" size="lg" />);
    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', '/sarah.png');
    fireEvent.error(img!);
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByRole('img', { name: 'Sarah Chen' })).toHaveTextContent('SC');
  });

  it('computes initials', () => {
    expect(getInitials('Sarah Chen')).toBe('SC');
    expect(getInitials('Cher')).toBe('C');
    expect(getInitials('Mary Jane Watson')).toBe('MW');
    expect(getInitials('  ')).toBe('?');
  });
});
