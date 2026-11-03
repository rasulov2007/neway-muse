import { describe, expect, it } from 'vitest';
import {
  PairDriversSchema,
  UnpairDriversSchema,
  pairableCandidates,
  pairingRefusal,
  partnerOn,
  teamInForceOn,
  teamLabel,
  unpairingRefusal,
  type PairingDriverFacts,
} from './team-pairing.js';

const TODAY = '2026-10-25';
const facts = (over: Partial<PairingDriverFacts> = {}): PairingDriverFacts => ({
  id: 'drv_a',
  name: 'Ali Karimov',
  status: 'available',
  archived: false,
  currentPartnerName: null,
  lastEndedOn: null,
  ...over,
});
const a = facts();
const b = facts({ id: 'drv_b', name: 'Bek Tursunov' });

describe('pairingRefusal', () => {
  it('pairs two free, active drivers', () => {
    expect(pairingRefusal(a, b, TODAY, TODAY)).toBeNull();
    expect(pairingRefusal(a, b, '2026-10-20', TODAY)).toBeNull();
  });

  it('refuses a driver with themselves', () => {
    expect(pairingRefusal(a, a, TODAY, TODAY)).toEqual({ status: 422, message: 'A driver cannot be paired with themselves.' });
  });

  it('refuses a driver who already has a partner, on either side, with 409 and the partner named', () => {
    expect(pairingRefusal(facts({ currentPartnerName: 'Sardor Aliev' }), b, TODAY, TODAY)).toEqual({ status: 409, message: 'Ali Karimov is already in a team with Sardor Aliev. Unpair them first.' });
    expect(pairingRefusal(a, facts({ id: 'drv_b', name: 'Bek Tursunov', currentPartnerName: 'X' }), TODAY, TODAY)?.status).toBe(409);
  });

  it('refuses terminated, inactive and archived drivers', () => {
    expect(pairingRefusal(a, facts({ id: 'drv_b', name: 'Bek', status: 'terminated' }), TODAY, TODAY)?.status).toBe(422);
    expect(pairingRefusal(facts({ status: 'inactive' }), b, TODAY, TODAY)?.status).toBe(422);
    expect(pairingRefusal(a, facts({ id: 'drv_b', name: 'Bek', archived: true }), TODAY, TODAY)?.message).toMatch(/archived/);
  });

  it('refuses a future start, and a start that would overlap a past team', () => {
    expect(pairingRefusal(a, b, '2026-10-26', TODAY)?.status).toBe(422);
    const r = pairingRefusal(facts({ lastEndedOn: '2026-10-22' }), b, '2026-10-21', TODAY);
    expect(r).toEqual({ status: 409, message: 'Ali Karimov was in another team until 2026-10-22; the new team cannot start before that.' });
    // The first solo day may be the first day of the next team.
    expect(pairingRefusal(facts({ lastEndedOn: '2026-10-22' }), b, '2026-10-22', TODAY)).toBeNull();
  });
});

describe('unpairingRefusal', () => {
  it('ends an open team today or on a past day after the start', () => {
    expect(unpairingRefusal({ startedOn: '2026-10-01', endedOn: null }, TODAY, TODAY)).toBeNull();
    expect(unpairingRefusal({ startedOn: '2026-10-01', endedOn: null }, '2026-10-01', TODAY)).toBeNull();
  });
  it('refuses a split team, a future day, and a day before the start', () => {
    expect(unpairingRefusal({ startedOn: '2026-10-01', endedOn: '2026-10-10' }, TODAY, TODAY)?.status).toBe(409);
    expect(unpairingRefusal({ startedOn: '2026-10-01', endedOn: null }, '2026-10-26', TODAY)?.status).toBe(422);
    expect(unpairingRefusal({ startedOn: '2026-10-01', endedOn: null }, '2026-09-30', TODAY)?.status).toBe(422);
  });
});

describe('history: the team in force on a day', () => {
  const rows = [
    { driverId: 'drv_a', partner: 'drv_b', startedOn: '2026-09-01', endedOn: '2026-10-01' },
    { driverId: 'drv_a', partner: 'drv_c', startedOn: '2026-10-05', endedOn: null },
  ];
  it('startedOn is the first team day, endedOn the first solo day', () => {
    expect(teamInForceOn(rows[0]!, '2026-09-01')).toBe(true);
    expect(teamInForceOn(rows[0]!, '2026-09-30')).toBe(true);
    expect(teamInForceOn(rows[0]!, '2026-10-01')).toBe(false);
    expect(teamInForceOn(rows[0]!, '2026-08-31')).toBe(false);
  });
  it('a past week reads the partner of that week, the gap reads Solo', () => {
    expect(partnerOn(rows, 'drv_a', '2026-09-15')?.partner).toBe('drv_b');
    expect(partnerOn(rows, 'drv_a', '2026-10-03')).toBeNull();
    expect(partnerOn(rows, 'drv_a', TODAY)?.partner).toBe('drv_c');
    expect(partnerOn(rows, 'drv_b', TODAY)).toBeNull();
  });
  it('labels', () => {
    expect(teamLabel('Bek Tursunov')).toBe('Team · with Bek Tursunov');
    expect(teamLabel(null)).toBe('Solo');
  });
});

describe('pairableCandidates', () => {
  const drivers = [
    { id: 'drv_a', name: 'Ali Karimov', driverNumber: 'D-1', status: 'available', archivedAt: null },
    { id: 'drv_b', name: 'Bek Tursunov', driverNumber: 'D-2', status: 'driving', archivedAt: null },
    { id: 'drv_c', name: 'Bobur Aliev', driverNumber: 'D-3', status: 'terminated', archivedAt: null },
    { id: 'drv_d', name: 'Botir Ergashev', driverNumber: 'D-4', status: 'available', archivedAt: '2026-10-02T00:00:00Z' },
    { id: 'drv_e', name: 'Bahrom Usmonov', driverNumber: 'D-5', status: 'off_duty', archivedAt: null },
  ];
  it('offers active, unpaired drivers other than the driver, filtered by name or number', () => {
    expect(pairableCandidates(drivers, 'drv_a', new Set(), '').map((d) => d.id)).toEqual(['drv_e', 'drv_b']);
    expect(pairableCandidates(drivers, 'drv_a', new Set(['drv_e']), 'b').map((d) => d.id)).toEqual(['drv_b']);
    expect(pairableCandidates(drivers, 'drv_a', new Set(), 'd-5').map((d) => d.id)).toEqual(['drv_e']);
  });
});

describe('schemas', () => {
  it('needs a partner; unpair needs a version and a reason', () => {
    expect(PairDriversSchema.safeParse({ partnerId: '' }).success).toBe(false);
    expect(PairDriversSchema.parse({ partnerId: 'drv_b' })).toEqual({ partnerId: 'drv_b', note: null });
    expect(UnpairDriversSchema.safeParse({ version: 1, reason: 'x' }).success).toBe(false);
    expect(UnpairDriversSchema.safeParse({ version: 1, reason: 'Bek went solo' }).success).toBe(true);
  });
});
