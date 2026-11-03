import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Tabs, TabsContent } from './Tabs';

const items = [
  { value: 'overview', label: 'Overview' },
  { value: 'loads', label: 'Loads', count: 12 },
  { value: 'docs', label: 'Documents', disabled: true },
];

describe('Tabs', () => {
  it('switches panels on click and reports the change', async () => {
    const onValueChange = vi.fn();
    render(
      <Tabs items={items} defaultValue="overview" onValueChange={onValueChange}>
        <TabsContent value="overview">Overview panel</TabsContent>
        <TabsContent value="loads">Loads panel</TabsContent>
      </Tabs>,
    );
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByText('Overview panel')).toBeInTheDocument();
    expect(screen.queryByText('Loads panel')).toBeNull();

    await userEvent.click(screen.getByRole('tab', { name: /Loads/ }));
    expect(onValueChange).toHaveBeenCalledWith('loads');
    expect(screen.getByText('Loads panel')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Loads/ })).toHaveTextContent('12');
  });

  it('respects disabled items and controlled value', async () => {
    const onValueChange = vi.fn();
    render(
      <Tabs items={items} value="overview" onValueChange={onValueChange} variant="segmented" />,
    );
    expect(screen.getByRole('tab', { name: /Documents/ })).toBeDisabled();
    await userEvent.click(screen.getByRole('tab', { name: /Loads/ }));
    expect(onValueChange).toHaveBeenCalledWith('loads');
    // still controlled by the parent
    expect(screen.getByRole('tab', { name: /Overview/ })).toHaveAttribute('aria-selected', 'true');
  });
});
