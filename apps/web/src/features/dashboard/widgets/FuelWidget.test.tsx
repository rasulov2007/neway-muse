import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { fuelFixture } from '../__fixtures__';
import { FULL_VISIBILITY, visibilityOf } from '../visibility';
import { FuelWidget } from './FuelWidget';

/** The `<td>` opposite a label in the totals list, so the assertions read like the card does. */
function stat(label: string): HTMLElement {
  const header = screen.getByRole('rowheader', { name: label });
  const cell = header.closest('tr')?.querySelector('td');
  if (!cell) throw new Error(`no value cell for "${label}"`);
  return cell as HTMLElement;
}

function withTotals(totals: Partial<ReturnType<typeof fuelFixture>['totals']>) {
  const base = fuelFixture();
  return fuelFixture({ totals: { ...base.totals, ...totals } });
}

describe('FuelWidget', () => {
  it('lays the totals out as a label/value list', () => {
    render(<FuelWidget fuel={fuelFixture()} visibility={FULL_VISIBILITY} />);

    // Three decimals: cents alone would hide the spread the fuel programme is judged on.
    expect(stat('Price per gallon')).toHaveTextContent('$3.570');
    expect(stat('Gallons')).toHaveTextContent('11,200');
    expect(stat('Fill-ups')).toHaveTextContent('84');
    expect(stat('Discounted total')).toHaveTextContent('$40,000.00');
    expect(stat('Retail total')).toHaveTextContent('$43,200.00');
    expect(stat('Fuel cost / mile')).toHaveTextContent('$0.74');
    // No tiles: the headline block is a two-column list.
    expect(screen.getByTestId('fuel-totals').querySelectorAll('table')).toHaveLength(2);
  });

  it('computes the discount and its share of the retail total', () => {
    render(<FuelWidget fuel={fuelFixture()} visibility={FULL_VISIBILITY} />);

    expect(stat('Discount')).toHaveTextContent('$3,200.00'); // 43,200 − 40,000
    expect(stat('Discount %')).toHaveTextContent('7.4%'); // 3,200 ÷ 43,200
  });

  it('shows a real zero discount when retail equals the discounted total', () => {
    render(
      <FuelWidget fuel={withTotals({ grossCost: 40000 })} visibility={FULL_VISIBILITY} />, // == discounted
    );

    expect(stat('Discount')).toHaveTextContent('$0.00');
    expect(stat('Discount %')).toHaveTextContent('0.0%');
    expect(screen.queryByText(/retail total and discount are pending/)).toBeNull();
  });

  it('renders "—" with a reason when the feed carries no retail price', () => {
    render(<FuelWidget fuel={withTotals({ grossCost: null })} visibility={FULL_VISIBILITY} />);

    for (const label of ['Retail total', 'Discount', 'Discount %']) {
      expect(stat(label)).toHaveTextContent('—');
      expect(stat(label)).toHaveAttribute(
        'title',
        expect.stringContaining('carries the final price only'),
      );
    }
    // The card says why, rather than showing a fabricated retail number.
    expect(screen.getByText(/retail total and discount are pending/)).toBeInTheDocument();
    // A missing retail price never blanks the numbers we do have.
    expect(stat('Discounted total')).toHaveTextContent('$40,000.00');
  });

  it('explains a missing fuel cost per mile instead of showing zero', () => {
    render(
      <FuelWidget fuel={withTotals({ fuelCostPerMile: null })} visibility={FULL_VISIBILITY} />,
    );

    expect(stat('Fuel cost / mile')).toHaveTextContent('—');
    expect(stat('Fuel cost / mile')).toHaveAttribute('title', expect.stringContaining('mileage'));
  });

  it('masks money but keeps the operational counts when financial visibility is off', () => {
    render(<FuelWidget fuel={fuelFixture({ masked: true })} visibility={visibilityOf(true)} />);

    for (const label of [
      'Price per gallon',
      'Discounted total',
      'Retail total',
      'Discount',
      'Discount %',
      'Fuel cost / mile',
    ]) {
      expect(stat(label)).toHaveTextContent('••••••');
    }
    expect(stat('Gallons')).toHaveTextContent('11,200');
    expect(stat('Fill-ups')).toHaveTextContent('84');
    expect(screen.queryByText('$40,000.00')).toBeNull();
  });

  it('drills down from the discounted total and keeps the truck/driver tabs', async () => {
    const onDrilldown = vi.fn();
    render(
      <FuelWidget fuel={fuelFixture()} visibility={FULL_VISIBILITY} onDrilldown={onDrilldown} />,
    );

    await userEvent.click(within(stat('Discounted total')).getByRole('button'));
    expect(onDrilldown).toHaveBeenCalledWith({ kind: 'metric', metric: 'fuel' });

    expect(screen.getByRole('columnheader', { name: 'Truck' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: 'By driver' }));
    expect(screen.getByRole('columnheader', { name: 'Driver' })).toBeInTheDocument();
    expect(screen.getByText('Marcus Lee')).toBeInTheDocument();
  });

  it('does not offer a drilldown while the money is masked', () => {
    render(
      <FuelWidget
        fuel={fuelFixture({ masked: true })}
        visibility={visibilityOf(true)}
        onDrilldown={vi.fn()}
      />,
    );

    expect(within(stat('Discounted total')).queryByRole('button')).toBeNull();
  });
});
