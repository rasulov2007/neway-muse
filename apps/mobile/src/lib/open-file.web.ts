import { t } from '../i18n/core';
import { api, loadToken } from '@/api/client';
import { API_URL, absoluteUrl } from '@/lib/config';

/** Opens a file through a 5-minute signed link the server hands this session. */
export async function openSignedLink(linkRoute: string): Promise<void> {
  const link = await api.get<{ url: string }>(linkRoute);
  window.open(absoluteUrl(link.url), '_blank', 'noopener');
}

/**
 * The web build: the PDF is fetched with the session and saved as a download. A new tab opened
 * after the fetch would no longer count as the person's click and is blocked as a popup.
 */
export async function openAuthorizedPdf(route: string, fileName: string): Promise<void> {
  const token = await loadToken();
  const response = await fetch(`${API_URL}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(t('The statement could not be opened ({status}).', { status: response.status }));
  const url = URL.createObjectURL(await response.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
