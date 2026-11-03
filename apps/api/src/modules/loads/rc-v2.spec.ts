import { describe, expect, it } from 'vitest';
import { RateConfirmationExtractSchema } from '@neway/shared';
import { compactRcTextV2 } from './rc-text';
import { expandV2Answer } from './rc-ollama';

describe('compactRcTextV2 (must match rctrain/build_text_v2.py compact)', () => {
  it('marks column gaps, drops blank and rule lines, keeps lines with numbers', () => {
    const text = 'Load #   12345\f\n   ---- \n\nPickup:    Atlanta, GA 30315   08/14/2026 13:30\n';
    expect(compactRcTextV2(text)).toBe('Load # | 12345\nPickup: | Atlanta, GA 30315 | 08/14/2026 13:30\n');
  });

  it('drops legal prose with no digit but keeps prose that carries a number', () => {
    const prose = 'Carrier shall be solely responsible for any fines penalties citations or claims of any nature whatsoever';
    const money = 'Detention will be paid at thirty dollars an hour after two free hours up to $250';
    expect(compactRcTextV2(`${prose}\n${money}\n`)).toBe(`${money}\n`);
  });

  it('stops at the character cap on a whole line', () => {
    const out = compactRcTextV2('A1 '.repeat(10) + '\n' + 'B2 '.repeat(10) + '\n', 40);
    expect(out).toBe(`${'A1 '.repeat(10).trim()}\n`);
  });
});

describe('expandV2Answer', () => {
  it('turns a compact answer into a full, valid reading', () => {
    const compact = { brokerName: 'Trekker Logistics, LLC', brokerLoadNumber: 316617, totalRate: 1600, weightLbs: 22200, equipment: 'dry_van',
      stops: [{ kind: 'pickup', city: 'ATLANTA', state: 'GA', zip: 30315, date: '2026-08-14', time: '13:30' }, { kind: 'delivery', city: 'BELVIDERE', state: 'IL' }] };
    const full = RateConfirmationExtractSchema.parse(expandV2Answer(compact));
    expect(full.brokerMc).toBeNull();
    expect(full.brokerLoadNumber).toBe('316617');
    expect(full.stops[0]).toMatchObject({ zip: '30315', street: null, endTime: null });
    expect(full.stops[1]!.date).toBeNull();
    expect(full.notes).toBeNull();
    expect(full.warnings).toEqual([]);
  });
});
