import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadFile } from '@/lib/files';
import { uploadScreenshot } from './api';

vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/files')>()),
  uploadFile: vi.fn(async (file: File) => ({
    id: 'file_test',
    url: '/api/v1/files/file_test',
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  })),
}));

/** A file of a given type and size, without the bytes. */
function fakeFile(name: string, type: string, size: number): File {
  const file = new File([''], name, { type });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

describe('a screenshot is checked before it is uploaded (§3.3)', () => {
  afterEach(() => vi.mocked(uploadFile).mockClear());

  it('sends an image and remembers what the defect keeps about it', async () => {
    const shot = await uploadScreenshot(fakeFile('brakes-04-18.png', 'image/png', 320_000), 'Tom Brennan');
    expect(uploadFile).toHaveBeenCalledTimes(1);
    expect(shot).toMatchObject({ fileId: 'file_test', fileName: 'brakes-04-18.png', uploadedBy: 'Tom Brennan' });
    expect(shot.uploadedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('refuses a document before a byte leaves the browser, and says so', async () => {
    await expect(uploadScreenshot(fakeFile('invoice.pdf', 'application/pdf', 1000), 'Tom')).rejects.toThrow(/image/);
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('refuses a file too large to be a screenshot', async () => {
    await expect(uploadScreenshot(fakeFile('video.png', 'image/png', 11 * 1024 * 1024), 'Tom')).rejects.toThrow(/10 MB/);
    expect(uploadFile).not.toHaveBeenCalled();
  });
});
