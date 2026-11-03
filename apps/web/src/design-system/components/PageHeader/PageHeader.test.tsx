import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Badge } from '../Badge';
import { Tabs } from '../Tabs';
import { PageHeader } from './PageHeader';

describe('PageHeader', () => {
  it('renders title, description, back action, meta and actions', () => {
    render(
      <PageHeader
        title="Unit 2785"
        description="Freightliner Cascadia"
        back={<button type="button">Back</button>}
        meta={<Badge tone="success">Active</Badge>}
        actions={<button type="button">Edit</button>}
      />,
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Unit 2785' })).toBeInTheDocument();
    expect(screen.getByText('Freightliner Cascadia')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back' })).toBeInTheDocument();
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeInTheDocument();
    expect(screen.getByRole('banner')).not.toHaveClass('border-b');
  });

  it('adds the bottom border only when tabs are present', () => {
    render(
      <PageHeader
        title="Loads"
        tabs={<Tabs items={[{ value: 'all', label: 'All' }]} defaultValue="all" />}
      />,
    );
    expect(screen.getByRole('banner')).toHaveClass('border-b');
    expect(screen.getByRole('tab', { name: 'All' })).toBeInTheDocument();
  });
});
