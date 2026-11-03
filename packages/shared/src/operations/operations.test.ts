import { describe, expect, it } from 'vitest';
import { buildAttentionQueue, type AttentionLoad } from './attention.js';
import { driverAvailability, truckAvailability } from './availability.js';
import { computeLoadEconomics } from './economics.js';
import { assessLoadRisk } from './risk.js';
import { trackingFreshness } from './tracking.js';

const NOW = '2026-09-09T15:00:00.000Z';

describe('trackingFreshness', () => {
  it('grades a fix by age', () => {
    expect(trackingFreshness('2026-09-09T14:59:00.000Z', NOW).state).toBe('live');
    expect(trackingFreshness('2026-09-09T14:50:00.000Z', NOW).state).toBe('recent');
    expect(trackingFreshness('2026-09-09T14:20:00.000Z', NOW).state).toBe('stale');
    expect(trackingFreshness('2026-09-09T12:00:00.000Z', NOW).state).toBe('offline');
  });

  it('separates a unit that never reported from one that stopped', () => {
    const never = trackingFreshness(null, NOW);
    expect(never.state).toBe('none');
    expect(never.ageMinutes).toBeNull();
    expect(trackingFreshness('2026-09-09T09:00:00.000Z', NOW).state).toBe('offline');
  });

  it('will not read a future timestamp as live-with-negative-age', () => {
    const skewed = trackingFreshness('2026-09-09T15:30:00.000Z', NOW);
    expect(skewed.ageMinutes).toBe(0);
    expect(skewed.state).toBe('live');
  });

  it('marks only live and recent positions usable', () => {
    expect(trackingFreshness('2026-09-09T14:59:00.000Z', NOW).usable).toBe(true);
    expect(trackingFreshness('2026-09-09T14:20:00.000Z', NOW).usable).toBe(false);
  });
});

describe('computeLoadEconomics', () => {
  const costs = { fuel: 600, driverPay: 640, tolls: 70, maintenanceAllocation: 150, other: 60 };

  it('restates a load on total miles and costs the deadhead', () => {
    const e = computeLoadEconomics({ revenue: 3850, loadedMiles: 1000, emptyMiles: 200, costs });
    expect(e.totalMiles).toBe(1200);
    expect(e.deadheadPct).toBe(16.7);
    expect(e.bookedCost).toBe(1520);
    // (600 + 640 + 150) / 1000 = $1.39/mi running rate, over 200 empty miles.
    expect(e.deadheadCost).toBe(278);
    expect(e.totalCost).toBe(1798);
    expect(e.profit).toBe(2052);
    expect(e.estimated).toBe(true);
  });

  it('shows revenue per mile falling once empty miles are counted', () => {
    const e = computeLoadEconomics({ revenue: 3000, loadedMiles: 1000, emptyMiles: 250, costs });
    expect(e.revenuePerLoadedMile).toBe(3);
    expect(e.revenuePerTotalMile).toBe(2.4);
    expect(e.reasons.some((r) => r.includes('falls from'))).toBe(true);
  });

  it('ranks a higher-rate long-deadhead load below a lower-rate tight one', () => {
    // The point of costing deadhead: judged on loaded miles the far load looks better, and it is
    // not, because 600 empty miles cost more than the extra $100 of linehaul earns.
    const far = computeLoadEconomics({ revenue: 2600, loadedMiles: 1000, emptyMiles: 600, costs });
    const near = computeLoadEconomics({ revenue: 2500, loadedMiles: 1000, emptyMiles: 20, costs });

    expect(far.revenuePerLoadedMile).toBeGreaterThan(near.revenuePerLoadedMile as number);
    expect(far.revenuePerTotalMile).toBeLessThan(near.revenuePerTotalMile as number);
    expect(far.profit as number).toBeLessThan(near.profit as number);
    expect(far.profitPerTotalMile as number).toBeLessThan(near.profitPerTotalMile as number);
  });

  it('returns nulls and names what is missing rather than zeros', () => {
    const e = computeLoadEconomics({ revenue: null, loadedMiles: 900, emptyMiles: 50, costs });
    expect(e.profit).toBeNull();
    expect(e.marginPct).toBeNull();
    expect(e.insufficient).toContain('revenue');

    const noMiles = computeLoadEconomics({
      revenue: 1000,
      loadedMiles: null,
      emptyMiles: null,
      costs,
    });
    expect(noMiles.totalMiles).toBeNull();
    expect(noMiles.costPerTotalMile).toBeNull();
    expect(noMiles.insufficient).toContain('loaded miles');
  });

  it('does not invent a deadhead rate when there are no loaded miles', () => {
    const e = computeLoadEconomics({ revenue: 400, loadedMiles: 0, emptyMiles: 120, costs });
    expect(e.deadheadCost).toBeNull();
    expect(e.estimated).toBe(false);
    expect(e.insufficient.some((m) => m.includes('per-mile basis'))).toBe(true);
  });
});

describe('assessLoadRisk', () => {
  const base = {
    loadStatus: 'in_transit',
    appointmentStartAt: '2026-09-09T16:00:00.000Z',
    appointmentEndAt: '2026-09-09T18:00:00.000Z',
    exception: null,
    tracking: 'live' as const,
    nowIso: NOW,
  };

  it('grades lateness against the appointment window', () => {
    expect(assessLoadRisk({ ...base, etaAt: '2026-09-09T17:00:00.000Z' }).state).toBe('on_track');
    expect(assessLoadRisk({ ...base, etaAt: '2026-09-09T18:15:00.000Z' }).state).toBe('at_risk');
    expect(assessLoadRisk({ ...base, etaAt: '2026-09-09T19:30:00.000Z' }).state).toBe('critical');
  });

  it('watches a load arriving right on the edge of the window', () => {
    expect(assessLoadRisk({ ...base, etaAt: '2026-09-09T17:45:00.000Z' }).state).toBe('watch');
  });

  it('says what it is missing instead of guessing', () => {
    const noEta = assessLoadRisk({ ...base, etaAt: null });
    expect(noEta.state).toBe('insufficient_data');
    expect(noEta.missing).toContain('a current ETA');
    expect(noEta.requiredAction).toContain('a current ETA');

    const noAppt = assessLoadRisk({ ...base, etaAt: NOW, appointmentEndAt: null });
    expect(noAppt.state).toBe('insufficient_data');
    expect(noAppt.missing).toContain('a delivery appointment window');
  });

  it('never reports on_track for a load it cannot verify', () => {
    const stale = assessLoadRisk({
      ...base,
      etaAt: '2026-09-09T17:00:00.000Z',
      tracking: 'offline',
    });
    expect(stale.state).toBe('watch');
    expect(stale.unverified).toBe(true);
    expect(stale.reasons.some((r) => r.includes('cannot be verified'))).toBe(true);
  });

  it('honours an exception already raised by a person', () => {
    const flagged = assessLoadRisk({
      ...base,
      etaAt: '2026-09-09T17:00:00.000Z',
      exception: { code: 'at_risk', reason: 'Receiver dock backed up' },
    });
    expect(flagged.state).toBe('at_risk');
    expect(flagged.reasons.some((r) => r.includes('Receiver dock backed up'))).toBe(true);
  });

  it('stops assessing a finished load', () => {
    expect(assessLoadRisk({ ...base, loadStatus: 'delivered', etaAt: null }).state).toBe(
      'not_applicable',
    );
  });
});

describe('driverAvailability', () => {
  const ok = { status: 'available', currentLoadStatus: null, compliant: true, gateReasons: [] };

  it('marks a qualified, unassigned driver assignable', () => {
    const r = driverAvailability(ok);
    expect(r.state).toBe('available');
    expect(r.assignable).toBe(true);
  });

  it('puts a compliance gate above whatever the driver is doing', () => {
    const held = driverAvailability({
      ...ok,
      currentLoadStatus: 'in_transit',
      compliant: false,
      gateReasons: ['DOT medical certificate expired'],
    });
    expect(held.state).toBe('compliance_hold');
    expect(held.assignable).toBe(false);
    expect(held.reasons[0]).toContain('DOT medical certificate expired');
    expect(held.blocker).toContain('DOT medical certificate expired');
  });

  it('reads the current load to place the driver', () => {
    expect(driverAvailability({ ...ok, currentLoadStatus: 'at_pickup' }).state).toBe('at_pickup');
    expect(driverAvailability({ ...ok, currentLoadStatus: 'in_transit' }).state).toBe('driving');
    expect(driverAvailability({ ...ok, currentLoadStatus: 'assigned' }).state).toBe('assigned');
  });

  it('separates suspension from a qualification hold', () => {
    expect(driverAvailability({ ...ok, status: 'suspended' }).state).toBe('safety_hold');
    expect(driverAvailability({ ...ok, status: 'terminated' }).state).toBe('inactive');
  });
});

describe('truckAvailability', () => {
  const ok = {
    status: 'active',
    maintenanceStatus: 'ok' as const,
    onLoad: false,
    compliant: true,
    gateReasons: [],
  };

  it('marks an in-service, compliant, unloaded unit assignable', () => {
    expect(truckAvailability(ok).assignable).toBe(true);
  });

  it('holds a unit with an overdue service', () => {
    const r = truckAvailability({ ...ok, maintenanceStatus: 'overdue' });
    expect(r.state).toBe('maintenance_overdue');
    expect(r.assignable).toBe(false);
    expect(r.blocker).toContain('overdue service');
  });

  it('holds a unit failing vehicle compliance, quoting the gate', () => {
    const r = truckAvailability({
      ...ok,
      compliant: false,
      gateReasons: ['Annual DOT inspection expired'],
    });
    expect(r.state).toBe('compliance_hold');
    expect(r.reasons[0]).toContain('Annual DOT inspection expired');
  });

  it('still flags a unit that is available but due soon', () => {
    const r = truckAvailability({ ...ok, maintenanceStatus: 'due_soon' });
    expect(r.assignable).toBe(true);
    expect(r.reasons.some((x) => x.includes('due soon'))).toBe(true);
  });
});

describe('buildAttentionQueue', () => {
  function load(overrides: Partial<AttentionLoad> = {}): AttentionLoad {
    return {
      id: 'ld_1',
      loadNumber: 'L-1',
      status: 'in_transit',
      risk: 'on_track',
      tracking: 'live',
      hasDriver: true,
      hasTruck: true,
      marginPct: 22,
      deadheadPct: 5,
      nextAppointmentAt: '2026-09-10T12:00:00.000Z',
      ...overrides,
    };
  }

  it('counts only live work and links each count to the records behind it', () => {
    const queue = buildAttentionQueue({
      nowIso: NOW,
      loads: [
        load({ id: 'a', risk: 'critical' }),
        load({ id: 'b', risk: 'at_risk' }),
        load({ id: 'c', status: 'delivered', risk: 'critical' }),
        load({ id: 'd', hasDriver: false }),
      ],
      trucks: [],
      drivers: [],
    });
    const critical = queue.items.find((i) => i.key === 'loads_critical');
    expect(critical?.count).toBe(1);
    expect(critical?.target).toEqual({ to: '/dispatch', search: { risk: 'critical' } });
    // The ids are the contract that keeps a count and the list it opens identical.
    expect(critical?.ids).toEqual(['a']);
    expect(queue.items.find((i) => i.key === 'loads_unassigned')?.count).toBe(1);
  });

  it('treats an unpriceable load as its own finding, not a zero', () => {
    const queue = buildAttentionQueue({
      nowIso: NOW,
      loads: [load({ marginPct: null }), load({ id: 'x', marginPct: 8 })],
      trucks: [],
      drivers: [],
    });
    expect(queue.items.find((i) => i.key === 'loads_unpriced')?.count).toBe(1);
    expect(queue.items.find((i) => i.key === 'loads_low_margin')?.count).toBe(1);
  });

  it('omits empty findings entirely', () => {
    const queue = buildAttentionQueue({ nowIso: NOW, loads: [load()], trucks: [], drivers: [] });
    expect(queue.items.some((i) => i.count === 0)).toBe(false);
    expect(queue.items.find((i) => i.key === 'loads_critical')).toBeUndefined();
  });

  it('declares the checks it cannot run instead of inventing them', () => {
    const queue = buildAttentionQueue({ nowIso: NOW, loads: [], trucks: [], drivers: [] });
    const hos = queue.unavailable.find((u) => u.key === 'hos_limits');
    expect(hos).toBeDefined();
    expect(hos?.requires).toContain('ELD');
    expect(queue.items.some((i) => i.key.includes('hos'))).toBe(false);
  });

  it('finds units that have been sitting', () => {
    const queue = buildAttentionQueue({
      nowIso: NOW,
      loads: [],
      trucks: [
        { id: 't1', unitNumber: '284', availability: 'available', idleHours: 30 },
        { id: 't2', unitNumber: '285', availability: 'available', idleHours: 3 },
        { id: 't3', unitNumber: '286', availability: 'in_shop', idleHours: null },
      ],
      drivers: [],
    });
    expect(queue.items.find((i) => i.key === 'trucks_sitting')?.count).toBe(1);
    expect(queue.items.find((i) => i.key === 'trucks_available')?.count).toBe(2);
    expect(queue.items.find((i) => i.key === 'trucks_unavailable')?.count).toBe(1);
  });
});
