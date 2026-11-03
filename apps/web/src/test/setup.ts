import '@testing-library/jest-dom/vitest';
import { beforeEach } from 'vitest';
import { invalidateRoster } from '@/demo/roster-api';
import { TEST_ACCOUNT, installRosterServer, resetRosterServer } from './roster-server';

// jsdom lacks a few browser APIs that Radix, cmdk and charts touch.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList;
}
if (!window.ResizeObserver) {
  window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}
if (!window.HTMLElement.prototype.hasPointerCapture) {
  window.HTMLElement.prototype.hasPointerCapture = () => false;
  window.HTMLElement.prototype.setPointerCapture = () => {};
  window.HTMLElement.prototype.releasePointerCapture = () => {};
}

// Trucks and drivers come from the API now. Tests have no PostgreSQL, so the transport is stubbed
// and everything above it — the client, the paging, the error mapping — runs exactly as it does in
// the browser. See src/test/roster-server.ts.
installRosterServer();
beforeEach(() => {
  resetRosterServer();
  invalidateRoster();
  /*
   * Signed in, like the product.
   *
   * Nothing in the application renders to a stranger, and screens that record who acted read the
   * session rather than a typed name — so a suite with no session in storage would be testing the
   * signed-out path everywhere and would never notice attribution breaking.
   */
  window.localStorage.setItem('neway.session.token', 'test-session-token');
  window.localStorage.setItem('neway.session.account', JSON.stringify(TEST_ACCOUNT));
});
