/** The web build has no document scanner: the scan screen offers the file picker instead. */
export interface ScannedImage {
  uri: string;
}

export function documentScannerAvailable(): boolean {
  return false;
}

export async function scanWithDocumentScanner(): Promise<ScannedImage[] | null> {
  return null;
}
