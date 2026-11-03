import { describe, expect, it } from 'vitest';
import { CreateTrailerSchema, TrailerSchema, UpdateTrailerSchema } from './trailers.js';

describe('CreateTrailerSchema — model (owner, 2026-10-22)', () => {
  const identity = { unitNumber: '5218', vin: '1GRAA0623KJ123456', year: 2026 };

  it('accepts a make and a model, trimmed', () => {
    const parsed = CreateTrailerSchema.parse({ ...identity, make: ' Utility ', model: ' 4000D-X ' });
    expect(parsed.make).toBe('Utility');
    expect(parsed.model).toBe('4000D-X');
  });

  it('accepts a model without a make, and neither', () => {
    const modelOnly = CreateTrailerSchema.parse({ ...identity, model: '4000D-X' });
    expect(modelOnly.model).toBe('4000D-X');
    expect(modelOnly.make).toBeUndefined();
    const bare = CreateTrailerSchema.parse(identity);
    expect(bare.model).toBeUndefined();
    expect(bare.make).toBeUndefined();
  });

  it('refuses a model longer than 40 characters', () => {
    const result = CreateTrailerSchema.safeParse({ ...identity, model: 'X'.repeat(41) });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe('Model is too long');
  });

  it('lets an update set or clear the model alone', () => {
    expect(UpdateTrailerSchema.parse({ model: 'Reefer 3000R' })).toEqual({ model: 'Reefer 3000R' });
    expect(UpdateTrailerSchema.parse({ model: null })).toEqual({ model: null });
  });

  it('does not carry the create defaults into an edit (no blank VIN, no dry van, no owned)', () => {
    expect(UpdateTrailerSchema.parse({ plate: 'ABC123' })).toEqual({ plate: 'ABC123' });
    expect(UpdateTrailerSchema.safeParse({ vin: 'NOTAVIN' }).success).toBe(false);
  });
});

describe('TrailerSchema — a trailer recorded before the model existed', () => {
  it('reads with a null make and a null model', () => {
    const record = {
      id: 'trl_5218',
      unitNumber: '5218',
      vin: '',
      year: null,
      make: null,
      model: null,
      type: 'dry_van',
      lengthFt: null,
      plate: null,
      plateState: null,
      status: 'available',
      ownership: 'owned',
      currentTruckId: null,
      currentTruckUnit: null,
      nextInspectionDate: null,
      homeTerminal: null,
      source: 'ditat',
      externalId: '42',
    };
    expect(TrailerSchema.parse(record).model).toBeNull();
  });
});
