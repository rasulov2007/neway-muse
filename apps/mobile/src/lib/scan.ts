import { t } from '../i18n/core';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';

import { keepFile, writeFileBytes } from '@/offline/files';

import { base64ToBytes, buildPdf } from './pdf';

/** Longest edge kept for a document page: sharp enough to read, small enough for a weak signal. */
const MAX_EDGE = 2000;

export interface ScannedPage {
  uri: string;
  width?: number;
  height?: number;
}

async function normalise(page: ScannedPage, withBytes: boolean) {
  const context = ImageManipulator.manipulate(page.uri);
  if (page.width && page.height && Math.max(page.width, page.height) > MAX_EDGE) {
    context.resize(page.width >= page.height ? { width: MAX_EDGE } : { height: MAX_EDGE });
  }
  const image = await context.renderAsync();
  return image.saveAsync({ compress: 0.7, format: SaveFormat.JPEG, base64: withBytes });
}

/**
 * Turns the pages into the one file the TMS takes: a JPEG for a single page, a PDF for several.
 * The result sits in the app's own storage until the server acknowledges it.
 */
export async function prepareDocument(
  pages: ScannedPage[],
  baseName: string,
): Promise<{ uri: string; name: string; type: string; size: number | null; pageCount: number }> {
  if (pages.length === 0) throw new Error(t('Add at least one page.'));
  if (pages.length === 1) {
    const jpeg = await normalise(pages[0]!, false);
    const name = `${baseName}.jpg`;
    const kept = await keepFile(jpeg.uri, name);
    return { uri: kept.uri, name, type: 'image/jpeg', size: kept.size, pageCount: 1 };
  }
  const rendered = [];
  for (const page of pages) {
    const jpeg = await normalise(page, true);
    if (!jpeg.base64) throw new Error(t('Could not read a page.'));
    rendered.push({ jpeg: base64ToBytes(jpeg.base64), width: jpeg.width, height: jpeg.height });
  }
  const name = `${baseName}.pdf`;
  const written = await writeFileBytes(name, buildPdf(rendered));
  return { uri: written.uri, name, type: 'application/pdf', size: written.size, pageCount: pages.length };
}
