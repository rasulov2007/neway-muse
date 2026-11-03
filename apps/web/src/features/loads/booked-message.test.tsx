import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HERO_LOAD_NUMBER, demoData, type Load } from '@/demo';
import { ToastProvider } from '@/design-system';
import { DriverMessageCard } from './DriverMessageCard';
import { bookedDriverMessage } from './booked-message';

/**
 * The Telegram message shown the moment a load is created (owner, 2026-10-23): written from the
 * load as booked, with no Rate line for a company driver and the For driver rate for anybody else.
 */
function load(over: Partial<Load> = {}): Load {
  const hero = demoData.loads.find((l) => l.loadNumber === HERO_LOAD_NUMBER);
  if (!hero) throw new Error('hero load missing');
  return { ...structuredClone(hero), brokerReference: 'BRK-77', rate: 3000, driverRate: 2500, charges: [], ...over };
}

describe('the booked load’s driver message', () => {
  it('has no Rate line for a company driver', () => {
    const text = bookedDriverMessage(load(), null, { driverType: 'company' });
    expect(text).not.toMatch(/Rate:/);
    expect(text).toContain('Load # BRK-77');
  });

  it('shows an owner operator the For driver rate, never the broker’s', () => {
    const text = bookedDriverMessage(load(), null, { driverType: 'owner_operator' });
    expect(text).toContain('Rate: $2500');
    expect(text).not.toContain('$3000');
  });

  it('with no driver yet, keeps the Rate line as before', () => {
    expect(bookedDriverMessage(load({ driverRate: null }), null, null)).toContain('Rate: $3000');
  });

  it('lists the booked stops, pickup first', () => {
    const l = load();
    const text = bookedDriverMessage(l, null, null);
    expect(text.indexOf('PU:')).toBeGreaterThan(-1);
    expect(text.indexOf('PU:')).toBeLessThan(text.indexOf('DEL:'));
    expect(text).toContain(l.stops[0]!.city);
  });

  it('puts Need Trailer then LIVE / DROP under the Load # line, Live when a stop never said (owner, 2026-10-26)', () => {
    const l = load();
    l.stops = l.stops.map((s) => ({ ...s, handling: undefined }));
    expect(bookedDriverMessage(l, null, null).split('\n').slice(0, 3)).toEqual(['Load # BRK-77', 'Need Trailer', 'LIVE / LIVE']);
    l.stops[l.stops.length - 1] = { ...l.stops[l.stops.length - 1]!, handling: 'drop' };
    expect(bookedDriverMessage(l, null, null).split('\n')[2]).toBe('LIVE / DROP');
  });

  it('reads Empty, Loaded and Total from the saved load', () => {
    const text = bookedDriverMessage(load({ loadedMiles: 350, emptyMiles: 45 }), null, { driverType: 'company' });
    expect(text).toContain('Empty: 45 miles\nLoaded: 350 miles\nTotal: 395 miles');
    expect(text).not.toMatch(/Rate:/);
    const none = bookedDriverMessage(load({ loadedMiles: 350, emptyMiles: 0 }), null, null);
    expect(none).not.toContain('Empty:');
    expect(none).toContain('Total: 350 miles');
  });

  it('the card shows the copy-ready text with a Copy button', () => {
    render(
      <ToastProvider>
        <DriverMessageCard initialText={bookedDriverMessage(load(), null, { driverType: 'company' })} />
      </ToastProvider>,
    );
    expect(screen.getByRole('button', { name: 'Copy' })).toBeEnabled();
    expect((screen.getByRole('textbox', { name: 'Driver message' }) as HTMLTextAreaElement).value).not.toMatch(/Rate:/);
  });

  it('carries the chosen TollGuru road right after the stops (owner, 2026-10-27)', () => {
    const route = { via: 'I-65 S', miles: 718, tollCost: 24.5 } as NonNullable<Load['route']>;
    const text = bookedDriverMessage(load({ route }), null, null);
    expect(text).toContain('——————————-\nRoute: I-65 S · 718 mi · tolls $24.50\n');
    expect(bookedDriverMessage(load(), null, null)).not.toContain('Route:');
  });

  it('a road chosen after the card opened goes into the edited text once', () => {
    const initial = bookedDriverMessage(load(), null, null);
    const { rerender } = render(
      <ToastProvider>
        <DriverMessageCard initialText={initial} routeLine={null} />
      </ToastProvider>,
    );
    const box = () => screen.getByRole('textbox', { name: 'Driver message' }) as HTMLTextAreaElement;
    fireEvent.change(box(), { target: { value: `${initial}\ntrailer 5301` } });
    rerender(
      <ToastProvider>
        <DriverMessageCard initialText={initial} routeLine="Route: I-65 S · 718 mi · tolls $24.50" />
      </ToastProvider>,
    );
    expect(box().value).toContain('Route: I-65 S · 718 mi · tolls $24.50');
    expect(box().value).toContain('trailer 5301');
    rerender(
      <ToastProvider>
        <DriverMessageCard initialText={initial} routeLine="Route: I-57 S · 702 mi · no tolls" />
      </ToastProvider>,
    );
    expect(box().value.match(/Route:/g)).toHaveLength(1);
  });
});
