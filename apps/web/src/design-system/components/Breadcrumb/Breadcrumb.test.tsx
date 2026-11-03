import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { Breadcrumb } from './Breadcrumb';

const items = [
  { label: 'Fleet', href: '/fleet' },
  { label: 'Trucks', href: '/fleet/trucks' },
  { label: 'Unit 2785', href: '/fleet/trucks/2785' },
];

describe('Breadcrumb', () => {
  it('renders links for all but the current page', () => {
    render(<Breadcrumb items={items} />);
    expect(screen.getByRole('navigation', { name: 'Breadcrumb' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fleet' })).toHaveAttribute('href', '/fleet');
    expect(screen.getByRole('link', { name: 'Trucks' })).toHaveAttribute('href', '/fleet/trucks');
    expect(screen.queryByRole('link', { name: 'Unit 2785' })).toBeNull();
    expect(screen.getByText('Unit 2785')).toHaveAttribute('aria-current', 'page');
  });

  it('renders hrefs through a custom link component', () => {
    const Link = ({
      to,
      children,
      className,
    }: {
      to: string;
      children: ReactNode;
      className?: string;
    }) => (
      <a href={to} data-router className={className}>
        {children}
      </a>
    );
    render(<Breadcrumb items={items} linkComponent={Link} />);
    expect(screen.getByRole('link', { name: 'Fleet' })).toHaveAttribute('data-router');
  });
});
