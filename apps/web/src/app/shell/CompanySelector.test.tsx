import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/features/auth/auth-context', () => ({
  useAccount: () => ({ companyId: 'co_aj', companyName: 'Harbor Line Transport', companies: [{ companyId: 'co_aj', companyName: 'Harbor Line Transport' }] }),
}));

import { CompanySelector } from './CompanySelector';

describe('CompanySelector (signed in, one company)', () => {
  it('shows the account’s own company, never the demo Northwind list (owner, 2026-10-27)', () => {
    render(<CompanySelector />);
    expect(screen.getByTestId('company-name')).toHaveTextContent('Harbor Line Transport');
    expect(screen.queryByText(/Northwind/)).not.toBeInTheDocument();
  });
});
