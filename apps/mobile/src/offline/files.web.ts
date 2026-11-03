import { t } from '../i18n/core';

/**
 * On the web build a picked or captured image is a blob: URI that dies with the page, so a queued
 * upload would be lost on a reload. The bytes are kept as a data: URI instead, which lives inside
 * the queue item (localStorage) and survives a reload or a closed tab, as the app's own file
 * storage does on a phone. Data URIs need no release; a blob URI is released once copied.
 */
function blobToDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error(t('Could not read the file.')));
    reader.readAsDataURL(blob);
  });
}

export async function keepFile(sourceUri: string, _name: string): Promise<{ uri: string; size: number | null }> {
  if (!sourceUri.startsWith('blob:')) return { uri: sourceUri, size: null };
  const blob = await (await fetch(sourceUri)).blob();
  const uri = await blobToDataUri(blob);
  return { uri, size: blob.size };
}

export async function deleteFile(uri: string): Promise<void> {
  if (uri.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(uri);
    } catch {
      // already released
    }
  }
}

export async function writeFileBytes(_name: string, bytes: Uint8Array): Promise<{ uri: string; size: number }> {
  const blob = new Blob([bytes as BlobPart], { type: 'application/pdf' });
  return { uri: await blobToDataUri(blob), size: bytes.length };
}
