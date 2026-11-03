/**
 * Where to go once signed in: the page that asked for the login. Shown in place on a protected
 * address, that is the address itself; on /login, the `next` it was sent with. Only a path on this
 * site is followed (never `//host` or a full URL), so a link cannot send someone elsewhere.
 */
export function destinationAfterLogin(location: Pick<Location, 'pathname' | 'search'> = window.location): string {
  const safe = (path: string | null) =>
    path && path.startsWith('/') && !path.startsWith('//') && !path.startsWith('/login') ? path : null;
  if (location.pathname !== '/login') return safe(location.pathname + location.search) ?? '/';
  return safe(new URLSearchParams(location.search).get('next')) ?? '/';
}
