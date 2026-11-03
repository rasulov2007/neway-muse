import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { demoData, type UnitExitRecord } from '@/demo';
import { UnitExitNotice } from './UnitExitNotice';
import { UnitExitsTab } from './UnitExitsTab';

/**
 * Stolen-unit privacy (owner decision): the server sends a non-administrator a redacted copy of a
 * stolen unit's exit record. The screens show the word "Stolen" and the unit's status - no blank
 * facts, no "Invalid date", no money.
 */

const redacted: UnitExitRecord = {
  id: 'exit_redacted_test',
  entity: 'truck',
  unitId: 'trk_redacted_test',
  unitNumber: '7777',
  toStatus: 'inactive',
  fromStatus: '',
  occurredOn: '',
  reason: 'stolen',
  narrative: '',
  odometer: null,
  salePrice: null,
  buyer: null,
  titleTransferred: null,
  policeReport: null,
  stolenFrom: null,
  recovered: null,
  contents: [],
  damage: [],
  injuries: null,
  driverId: null,
  driverName: null,
  loadNumber: null,
  insuranceClaimNumber: null,
  insuredValue: null,
  deductible: null,
  expectedRecovery: null,
  recordedById: null,
  recordedByName: '',
  createdAt: '',
  redacted: true,
};

afterEach(() => {
  const at = demoData.unitExits.findIndex((row) => row.id === redacted.id);
  if (at >= 0) demoData.unitExits.splice(at, 1);
});

describe('a redacted stolen record', () => {
  it('shows only "Stolen" and the unit status on the unit page', () => {
    demoData.unitExits.unshift(redacted);
    const { container } = render(<UnitExitNotice unitId={redacted.unitId} />);
    expect(screen.getByText('Stolen')).toBeInTheDocument();
    expect(screen.getByText('Inactive')).toBeInTheDocument();
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/Invalid date/i);
    expect(text).not.toMatch(/recorded by/i);
    expect(text).not.toMatch(/exposure/i);
    expect(text).not.toMatch(/\$/);
    expect(text).not.toMatch(/Police report|Taken from|Claim|Recovered/);
    // Symbol + word: the badge carries its status symbol.
    expect(container.querySelectorAll('svg').length).toBeGreaterThan(0);
  });

  it('shows no date, money or recorder in the Off the road list', () => {
    demoData.unitExits.unshift(redacted);
    const { container } = render(<UnitExitsTab />);
    expect(screen.getByText('7777')).toBeInTheDocument();
    expect(screen.getAllByText('Stolen').length).toBeGreaterThan(0);
    const row = screen.getByText('7777').closest('tr');
    const text = row?.textContent ?? container.textContent ?? '';
    expect(text).not.toMatch(/Invalid date/i);
    expect(text).not.toMatch(/exposed|No exposure recorded/);
  });
});
