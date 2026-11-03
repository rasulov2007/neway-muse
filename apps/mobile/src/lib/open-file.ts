import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';
import { Linking } from 'react-native';

import { api, loadToken } from '@/api/client';
import { API_URL, absoluteUrl } from '@/lib/config';

/** Opens a file through a 5-minute signed link the server hands this session. */
export async function openSignedLink(linkRoute: string): Promise<void> {
  const link = await api.get<{ url: string }>(linkRoute);
  await Linking.openURL(absoluteUrl(link.url));
}

/**
 * A PDF streamed to this session only (a pay statement): downloaded into the app's cache with the
 * bearer token, then handed to the phone's viewer / share sheet.
 */
export async function openAuthorizedPdf(route: string, fileName: string): Promise<void> {
  const token = await loadToken();
  const target = new File(Paths.cache, fileName);
  const file = await File.downloadFileAsync(`${API_URL}${route}`, target, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    idempotent: true,
  });
  if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(file.uri, { mimeType: 'application/pdf', UTI: 'com.adobe.pdf' });
  else await Linking.openURL(file.uri);
}
