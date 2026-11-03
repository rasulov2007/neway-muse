import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { env } from '../../config/env';
import { AppError } from '../../common/errors/app-error';
import type { MuseVisionService } from '../muse-vision/muse-vision.service';
import { RateConfirmationReaderService } from './rate-confirmation-reader.service';

type MutableEnv = { ANTHROPIC_API_KEY?: string; OLLAMA_URL?: string; RC_READER_PROVIDER: 'default' | 'muse'; RC_CARRIER_NUMBERS?: string };
const e = env as unknown as MutableEnv;

const wire = {
  brokerName: 'Sample Freight Brokerage LLC',
  brokerMc: 'MC 900001',
  brokerLoadNumber: 'Load # SFB-10442',
  totalRate: 2850,
  linehaulRate: 2600,
  commodity: 'Paper goods',
  weightLbs: 38000,
  equipment: 'dry_van',
  hazmat: false,
  temperature: null,
  miles: 812,
  stops: [
    { kind: 'pickup', facilityName: 'Demo Paper Mill', street: '100 Example Rd', city: 'Springfield', state: 'il', zip: '62701', date: '2026-11-10', time: '08:00', endTime: '', reference: 'PU-1' },
    { kind: 'delivery', facilityName: 'Demo DC', street: '', city: 'Columbus', state: 'OH', zip: '43215-1234', date: '2026-11-11', time: '', endTime: '', reference: '' },
  ],
  notes: null,
  warnings: [],
};

const fakeMuse = (impl: () => Promise<unknown>) =>
  ({ configured: true, readJson: vi.fn(impl) }) as unknown as MuseVisionService & { readJson: ReturnType<typeof vi.fn> };

const pdf = { fileName: 'rc.pdf', contentType: 'image/png' as const, content: 'iVBORw0KGgo=' };

describe('the RC reader with RC_READER_PROVIDER=muse', () => {
  let saved: MutableEnv;
  beforeEach(() => {
    saved = { ...e };
    e.RC_READER_PROVIDER = 'muse';
    e.ANTHROPIC_API_KEY = undefined;
    e.OLLAMA_URL = undefined;
    e.RC_CARRIER_NUMBERS = '900001';
  });
  afterEach(() => Object.assign(e, saved));

  it('reads through Muse and passes the answer through the usual checks', async () => {
    const muse = fakeMuse(async () => ({ data: wire, model: 'muse-spark-1.3', ms: 9000, usage: {} }));
    const result = await new RateConfirmationReaderService(muse).read('co_x', pdf);
    expect(result.model).toBe('muse:muse-spark-1.3');
    expect(result.extract.brokerLoadNumber).toBe('SFB-10442');
    // Our own MC is never the broker's.
    expect(result.extract.brokerMc).toBeNull();
    expect(result.extract.stops[0]).toMatchObject({ state: 'IL', endTime: null });
    expect(result.extract.stops[1]).toMatchObject({ zip: '43215', street: null, time: null });
    expect(muse.readJson).toHaveBeenCalledWith(expect.objectContaining({ schemaName: 'rate_confirmation' }));
  });

  it('says Muse is unavailable when no other reader is set up', async () => {
    const muse = fakeMuse(async () => {
      throw new AppError({ status: 503, title: 'Muse is busy' });
    });
    await expect(new RateConfirmationReaderService(muse).read('co_x', pdf)).rejects.toMatchObject({ status: 503 });
  });

  it('leaves the existing order alone when the provider is not muse', async () => {
    e.RC_READER_PROVIDER = 'default';
    const muse = fakeMuse(async () => ({ data: wire, model: 'm', ms: 1, usage: {} }));
    await expect(new RateConfirmationReaderService(muse).read('co_x', pdf)).rejects.toMatchObject({
      status: 422,
      title: 'This RC is a scan or a photo',
    });
    expect(muse.readJson).not.toHaveBeenCalled();
  });
});
