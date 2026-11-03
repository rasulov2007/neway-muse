import { describe, expect, it } from 'vitest';
import { allocateTireCost, parseTireText, summarizeTirePositions, tirePositionChip, tirePositionLabel, TIRE_POSITIONS } from './tire-positions.js';

const read = (text: string, kind: 'truck' | 'trailer' | null = 'truck') =>
  parseTireText(text, kind).map((e) => `${e.positionId}:${e.eventType}:${e.quantity}`);

describe('the 18 positions', () => {
  it('has steer 2, drive 8, trailer 8 with driver side L and passenger side R', () => {
    expect(TIRE_POSITIONS).toHaveLength(18);
    expect(TIRE_POSITIONS.filter((p) => p.group === 'drive')).toHaveLength(8);
    expect(tirePositionLabel('D1-LO')).toBe('Drive 1 · Left outer');
    expect(tirePositionLabel('S-R')).toBe('Steer · Right');
    expect(tirePositionChip('T2-LO')).toBe('Trailer 2 LO');
    expect(tirePositionChip('S-L')).toBe('Steer L');
  });
});

describe('parseTireText - the owner’s real descriptions (2026-10-13)', () => {
  it('REPLACE 2 TIRE I AXLE RIGHT, GREASE · REPLACE 2 BRAKE SHOES I AXLE', () => {
    const text = 'REPLACE 2 TIRE I AXLE RIGHT, GREASE · REPLACE 2 BRAKE SHOES I AXLE';
    // On a trailer: axle I, right side, two tires = both right duals. Brake shoes are not tires.
    expect(read(text, 'trailer')).toEqual(['T1-RI:replaced:1', 'T1-RO:replaced:1']);
    // On a tractor axle I is the steer: one tire a side, so two on the right is flagged lower.
    const truck = parseTireText(text, 'truck');
    expect(truck.map((e) => `${e.positionId}:${e.quantity}`)).toEqual(['S-R:2']);
    expect(truck[0]!.confidence).toBeLessThan(0.9);
  });

  it('REPLACE 8 DRIVE TIRES · REPLACE OUTPUT SEAL II AXLE = all eight drive positions', () => {
    const out = read('REPLACE 8 DRIVE TIRES · REPLACE OUTPUT SEAL II AXLE');
    expect(out).toHaveLength(8);
    expect(out.every((e) => e.startsWith('D') && e.endsWith(':replaced:1'))).toBe(true);
  });

  it('REPLACE USED TIRE III AXLE LH - drive 2 left, inner or outer not said: unassigned', () => {
    const [e] = parseTireText('REPLACE USED TIRE III AXLE LH', 'truck');
    expect(e).toMatchObject({ positionId: 'UNASSIGNED', eventType: 'replaced', quantity: 1 });
    expect(e!.note).toMatch(/Drive 2 · Left/);
    expect(e!.confidence).toBeLessThan(0.5);
  });

  it('new tire, mud flap and bracket - one replaced tire, position not said', () => {
    expect(read('new tire, mud flap and bracket')).toEqual(['UNASSIGNED:replaced:1']);
  });

  it('tire patch / stem valve fix - repaired, unassigned', () => {
    expect(read('tire patch')).toEqual(['UNASSIGNED:repaired:1']);
    expect(read('stem valve fix')).toEqual(['UNASSIGNED:repaired:1']);
  });

  it('2 new tires - two, unassigned', () => {
    expect(read('2 new tires')).toEqual(['UNASSIGNED:replaced:2']);
  });

  it('RS - trk used tire trl 2 new tire - the trailer tires never land on the truck', () => {
    const out = parseTireText('RS - trk used tire trl 2 new tire', 'truck');
    expect(out.map((e) => `${e.positionId}:${e.quantity}`)).toEqual(['UNASSIGNED:1', 'UNASSIGNED:2']);
    expect(out[1]!.note).toMatch(/trailer tire written on a truck record/);
  });

  it('new steer tires - both steer positions', () => {
    expect(read('new steer tires')).toEqual(['S-L:replaced:1', 'S-R:replaced:1']);
  });

  it('RRI used tire, mud flap and bracket fix - right rear inner: the rear drive axle, said so in the note', () => {
    const out = parseTireText('RRI used tire, mud flap and bracket fix', 'truck');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ positionId: 'D2-RI', eventType: 'replaced', confidence: 0.7 });
    expect(out[0]!.note).toMatch(/RRI read as Drive 2/);
    // On a trailer the rear of the tandem is its second axle.
    expect(read('RRI used tire', 'trailer')).toEqual(['T2-RI:replaced:1']);
  });

  it('New tire and airbag - one tire, unassigned', () => {
    expect(read('New tire and airbag')).toEqual(['UNASSIGNED:replaced:1']);
  });
});

describe('parseTireText - the rules', () => {
  it('reads blowouts, shorthand codes and explicit duals', () => {
    expect(read('blowout LF')).toEqual(['S-L:blowout:1']);
    expect(read('RF tire replaced')).toEqual(['S-R:replaced:1']);
    expect(read('II axle left outer tire blew', 'truck')).toEqual(['D1-LO:blowout:1']);
    expect(read('replace tire axle 2 RH inside', 'trailer')).toEqual(['T2-RI:replaced:1']);
  });

  it('reads a count written as a word, and never spreads it over the whole group', () => {
    expect(read('Replace two drive tires')).toEqual(['UNASSIGNED:replaced:2']);
    expect(read('replace both steer tires')).toEqual(['S-L:replaced:1', 'S-R:replaced:1']);
    expect(read('eight drive tires replaced')).toHaveLength(8);
  });

  it('reads the production shorthand (2026-10-13 dry run)', () => {
    expect(read('REPLACE 1 TIRE III AXLE LH IN · FIXED MUDFLAP,REPLACE REFLECTOR')).toEqual(['D2-LI:replaced:1']);
    expect(read('REPLACE 2 TIRE III AXLE L, TIRE ROTATION')).toEqual(['D2-LO:replaced:1', 'D2-LI:replaced:1']);
    expect(read('new RFI tire')).toEqual(['D1-RI:replaced:1']);
    expect(read('RFO used tire', 'trailer')).toEqual(['T1-RO:replaced:1']);
    expect(read('Used tire LRI')).toEqual(['D2-LI:replaced:1']);
  });

  it('a check, rotation or alignment is not a tire event', () => {
    expect(read('Light and tire psi check')).toEqual([]);
    expect(read('tires check and valve adjustment')).toEqual([]);
    expect(read('Truck / Axels / Tires Alignment. · Shop Supplies')).toEqual([]);
  });

  it('ignores text with no tire in it', () => {
    expect(read('REPLACE 2 BRAKE SHOES I AXLE')).toEqual([]);
    expect(read('')).toEqual([]);
  });

  it('does not place an axle number when the unit kind is unknown', () => {
    expect(read('REPLACE TIRE II AXLE LEFT OUTER', null)).toEqual(['UNASSIGNED:replaced:1']);
  });
});

describe('allocateTireCost', () => {
  it('splits by quantity to the cent', () => {
    const out = allocateTireCost([{ quantity: 1 }, { quantity: 1 }, { quantity: 1 }], 10000);
    expect(out.map((e) => e.costCents)).toEqual([3333, 3333, 3334]);
  });
});

describe('summarizeTirePositions', () => {
  const records = [
    { key: 'work_order:a', date: '2026-01-10', unitId: 't1', unitNumber: '0008' },
    { key: 'work_order:b', date: '2026-02-20', unitId: 't1', unitNumber: '0008' },
    { key: 'work_order:c', date: '2026-03-01', unitId: 't2', unitNumber: '1487' },
  ];
  const events = [
    { recordKey: 'work_order:a', positionId: 'S-L' as const, eventType: 'replaced' as const, quantity: 1, costCents: 50000 },
    { recordKey: 'work_order:b', positionId: 'S-L' as const, eventType: 'replaced' as const, quantity: 1, costCents: 50000 },
    { recordKey: 'work_order:c', positionId: 'D1-LO' as const, eventType: 'replaced' as const, quantity: 1, costCents: 40000 },
    { recordKey: 'work_order:c', positionId: 'UNASSIGNED' as const, eventType: 'replaced' as const, quantity: 2, costCents: 0 },
    { recordKey: 'work_order:c', positionId: 'S-R' as const, eventType: 'repaired' as const, quantity: 1, costCents: 0 },
    // Not one of the table's records: never counted.
    { recordKey: 'work_order:zzz', positionId: 'S-R' as const, eventType: 'replaced' as const, quantity: 5, costCents: 0 },
  ];

  it('counts only the records given, for one metric', () => {
    const s = summarizeTirePositions(records, events, 'replaced');
    expect(s.total).toBe(3);
    expect(s.positions['S-L'].count).toBe(2);
    expect(s.positions['S-R'].count).toBe(0);
    expect(s.unassigned).toEqual({ count: 2, recordKeys: ['work_order:c'] });
    expect(s.ranking[0]!.id).toBe('S-L');
    expect(s.positions['S-L'].lastDate).toBe('2026-02-20');
    expect(s.positions['S-L'].topUnits).toEqual([{ unitId: 't1', unitNumber: '0008', count: 2 }]);
    expect(s.groups.find((g) => g.group === 'steer')).toMatchObject({ count: 2, perTire: 1 });
    expect(summarizeTirePositions(records, events, 'repaired').total).toBe(1);
  });

  it('finds repeat offenders within 90 days and the outer-heavy duals', () => {
    const s = summarizeTirePositions(records, events, 'replaced');
    expect(s.insights.repeat).toEqual([{ unitId: 't1', unitNumber: '0008', positionId: 'S-L', times: 2 }]);
    expect(s.insights.outer).toBe(1);
    expect(s.insights.inner).toBe(0);
    expect(s.insights.outerHeavy).toBe(true);
  });

  it('renders zeros when there is nothing', () => {
    const s = summarizeTirePositions([], [], 'replaced');
    expect(s.total).toBe(0);
    expect(s.max).toBe(0);
    expect(s.insights.top).toBeNull();
  });
});
