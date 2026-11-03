import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { unitServiceStatus } from '@neway/shared';
import { apiGet, apiPost } from '@/lib/api-client';
import { setFlagForTests } from '@/lib/feature-flags';
import { assertDispatchAllowed, DispatchBlockedError, isDispatchBlocked } from './dispatch-guard';

vi.mock('@/lib/api-client', () => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

const unit = { id: 'trk_2718', unitNumber: '2718' };
const held = unitServiceStatus([{ id: 'pd_1', defectNumber: 'DEF-4417', severity: 'oos_risk', state: 'open' }]);
const watched = unitServiceStatus([{ id: 'pd_2', defectNumber: 'DEF-0002', severity: 'monitor', state: 'open' }]);

describe('a held unit is stopped at dispatch (§9.1)', () => {
  beforeEach(() => setFlagForTests('fleet_v2', true));
  afterEach(() => {
    setFlagForTests('fleet_v2', null);
    vi.mocked(apiGet).mockReset();
    vi.mocked(apiPost).mockReset();
  });

  it('lets a unit through when nothing blocks it, and logs nothing', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ verdict: watched, defects: [] });
    await expect(assertDispatchAllowed(unit, { ref: 'L-100201' })).resolves.toBeUndefined();
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('refuses an out-of-service unit, naming the defect and what releases it', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ verdict: held, defects: [] });
    const error = await assertDispatchAllowed(unit, { ref: 'L-100201' }).catch((e: unknown) => e);
    expect(isDispatchBlocked(error)).toBe(true);
    expect((error as DispatchBlockedError).message).toBe(
      'Unit 2718 is out of service — hold: DEF-4417. released when DEF-4417 is verified',
    );
    expect((error as DispatchBlockedError).verdict.defectIds).toEqual(['pd_1']);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('with a reason, logs the override on the server before letting the write go on', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ verdict: held, defects: [] });
    vi.mocked(apiPost).mockResolvedValueOnce({ overridden: true, verdict: held });
    await expect(
      assertDispatchAllowed(unit, { ref: 'L-100201' }, { reason: '  Brakes checked by hand at the yard  ' }),
    ).resolves.toBeUndefined();
    expect(apiPost).toHaveBeenCalledWith('/fleet/pti/units/trk_2718/dispatch-override', {
      loadRef: 'L-100201',
      reason: 'Brakes checked by hand at the yard',
    });
  });

  it('a blank reason is no reason', async () => {
    vi.mocked(apiGet).mockResolvedValueOnce({ verdict: held, defects: [] });
    await expect(assertDispatchAllowed(unit, { ref: 'L-100201' }, { reason: '   ' })).rejects.toBeInstanceOf(DispatchBlockedError);
    expect(apiPost).not.toHaveBeenCalled();
  });

  it('is silent with fleet_v2 off, as the routes it reads are not there', async () => {
    setFlagForTests('fleet_v2', false);
    await expect(assertDispatchAllowed(unit, { ref: 'L-100201' })).resolves.toBeUndefined();
    expect(apiGet).not.toHaveBeenCalled();
  });
});
