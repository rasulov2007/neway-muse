import { Directory, File, Paths } from 'expo-file-system';

/**
 * Photos are copied into the app's document directory (safe from the OS cache cleaner) the moment
 * they are kept, and deleted only after the TMS acknowledges them.
 */
function uploadsDir(): Directory {
  const dir = new Directory(Paths.document, 'uploads');
  if (!dir.exists) dir.create({ intermediates: true });
  return dir;
}

export async function keepFile(sourceUri: string, name: string): Promise<{ uri: string; size: number | null }> {
  const source = new File(sourceUri);
  const target = new File(uploadsDir(), name);
  if (target.exists) target.delete();
  await source.copy(target);
  let size: number | null = null;
  try {
    size = target.size ?? null;
  } catch {
    size = null;
  }
  return { uri: target.uri, size };
}

export async function deleteFile(uri: string): Promise<void> {
  const file = new File(uri);
  if (file.exists) file.delete();
}

/** Writes bytes made on the phone (a scanned PDF) straight into the uploads folder. */
export async function writeFileBytes(name: string, bytes: Uint8Array): Promise<{ uri: string; size: number }> {
  const target = new File(uploadsDir(), name);
  if (target.exists) target.delete();
  target.create();
  await target.write(bytes);
  return { uri: target.uri, size: bytes.length };
}
