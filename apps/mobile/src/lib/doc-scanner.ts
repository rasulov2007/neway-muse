import { TurboModuleRegistry } from 'react-native';

/**
 * The phone's own document scanner (mobile M7): edge detection, perspective crop and clean-up,
 * like the camera's "Documents" mode. Android uses Google ML Kit's document scanner, iOS VisionKit
 * (react-native-document-scanner-plugin). It is native code, so it exists only in a development or
 * store build (EAS); Expo Go does not carry it, and the scan screen falls back to its own camera
 * with a page frame (see app/driver/scan.tsx).
 */
export interface ScannedImage {
  uri: string;
}

/** True when this build has the native scanner (never in Expo Go or on the web). */
export function documentScannerAvailable(): boolean {
  try {
    return TurboModuleRegistry.get('DocumentScanner') != null;
  } catch {
    return false;
  }
}

/**
 * Opens the document scanner. Resolves with the pages (file URIs) or an empty list when the person
 * closed it; null when this build has no scanner.
 */
export async function scanWithDocumentScanner(maxPages = 20): Promise<ScannedImage[] | null> {
  if (!documentScannerAvailable()) return null;
  // Required here, not imported at the top: the module looks the native side up as it loads.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require('react-native-document-scanner-plugin') as typeof import('react-native-document-scanner-plugin');
  const scanner = mod.default;
  const result = await scanner.scanDocument({ croppedImageQuality: 85, maxNumDocuments: maxPages, responseType: mod.ResponseType.ImageFilePath });
  if (result.status === mod.ScanDocumentResponseStatus.Cancel) return [];
  return (result.scannedImages ?? []).map((p) => ({ uri: p.startsWith('file://') || p.startsWith('content://') ? p : `file://${p}` }));
}
