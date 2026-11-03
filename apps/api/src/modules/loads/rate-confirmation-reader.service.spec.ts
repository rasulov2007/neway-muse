import { describe, expect, it } from 'vitest';
import { env } from '../../config/env';
import { RateConfirmationReaderService } from './rate-confirmation-reader.service';

const withoutModels = async (run: () => Promise<void>) => {
  const saved = { key: env.ANTHROPIC_API_KEY, ollama: env.OLLAMA_URL };
  const e = env as { ANTHROPIC_API_KEY?: string; OLLAMA_URL?: string };
  e.ANTHROPIC_API_KEY = undefined;
  e.OLLAMA_URL = undefined;
  try {
    await run();
  } finally {
    e.ANTHROPIC_API_KEY = saved.key;
    e.OLLAMA_URL = saved.ollama;
  }
};

describe('the RC reader with no model on the server', () => {
  it('says a file without text is a scan, and calls nothing', () =>
    withoutModels(async () => {
      await expect(
        new RateConfirmationReaderService().read('co_x', { fileName: 'rc.png', contentType: 'image/png', content: 'iVBORw0KGgo=' }),
      ).rejects.toMatchObject({ status: 422, title: 'This RC is a scan or a photo' });
    }));

  it('refuses an empty file', () =>
    withoutModels(async () => {
      await expect(
        new RateConfirmationReaderService().read('co_x', { fileName: 'rc.pdf', contentType: 'application/pdf', content: '' + '=' }),
      ).rejects.toMatchObject({ status: 422 });
    }));
});
