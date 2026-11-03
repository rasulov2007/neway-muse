/*
 * NeWay · Appearance (Light / Dark / System): reference implementation.
 *
 * WHERE IT GOES
 *   Inline this file in <head>, before any stylesheet, so the theme is set before the first paint.
 *   Don't import it as a module: that runs after paint (white flash) and fails during server rendering.
 *   React/Next: add suppressHydrationWarning to <html>, because this script changes its attributes.
 *   A strict Content-Security-Policy needs a nonce or hash for this inline script.
 *   Remove any other theme switcher (next-themes, a ThemeProvider, a "light" class on <html>)
 *   so this is the only thing that sets the theme.
 *
 * HOW THE APP USES IT
 *   Every time the signed-in user's profile loads (app start, sign-in, profile refresh):
 *     const toSave = NewayAppearance.sync(user.id, user.appearance);
 *     if (toSave) saveAppearance(toSave);   // a choice made earlier didn't reach the server yet: retry
 *   When the worker picks Light / Dark / System:
 *     NewayAppearance.set(value, user.id);
 *     saveAppearance(value);                // PATCH /api/me/preferences { appearance: value }
 *   After the server confirms the save:
 *     NewayAppearance.markSaved(user.id);
 *   To update the menu when the theme changes (including from another tab):
 *     window.addEventListener('neway:appearance', e => { e.detail.appearance; e.detail.theme; });
 *
 * WHAT IS STORED IN THE BROWSER (localStorage)
 *   neway-appearance:<userId>          'light' | 'dark' | 'system'
 *   neway-appearance:<userId>:pending  '1' while the latest choice hasn't been saved to the server
 *   neway-appearance:last-user         the last user who signed in on this computer
 *   neway-appearance:device            the choice made while signed out
 *   Before sign-in, the page opens in the last signed-in user's theme. Another worker on the same
 *   computer may see that theme for a moment until sync() applies their own. To avoid even that,
 *   the server can render data-theme on <html> from the user's profile.
 */
(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;

  var PREFIX = 'neway-appearance';
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var current = 'system';

  function normalize(v) {
    if (typeof v !== 'string') return null;
    v = v.trim().toLowerCase();
    return v === 'light' || v === 'dark' || v === 'system' ? v : null;
  }
  function hasUser(userId) { return userId !== null && userId !== undefined && userId !== ''; }
  function keyFor(userId) { return PREFIX + ':' + (hasUser(userId) ? String(userId) : 'device'); }
  var memory = {};  // used when the browser blocks storage (private windows, strict settings)
  function read(key) {
    try { return window.localStorage.getItem(key); }
    catch (e) { return Object.prototype.hasOwnProperty.call(memory, key) ? memory[key] : null; }
  }
  function write(key, value) {
    try { window.localStorage.setItem(key, value); } catch (e) { memory[key] = value; }
  }
  function remove(key) {
    try { window.localStorage.removeItem(key); } catch (e) { delete memory[key]; }
  }

  function apply(pref) {
    current = normalize(pref) || 'system';
    var dark = current === 'dark' || (current === 'system' && !!(mq && mq.matches));
    var root = document.documentElement;
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-appearance', current);
    if (dark) { root.classList.add('dark'); } else { root.classList.remove('dark'); }
    root.classList.remove('light');
    root.style.colorScheme = dark ? 'dark' : 'light';
    try {
      window.dispatchEvent(new CustomEvent('neway:appearance', { detail: { appearance: current, theme: dark ? 'dark' : 'light' } }));
    } catch (e) {}
  }

  function setChoice(pref, userId) {
    var value = normalize(pref);
    if (!value) return false;
    write(keyFor(userId), value);
    if (hasUser(userId)) {
      write(PREFIX + ':last-user', String(userId));
      write(keyFor(userId) + ':pending', '1');
    }
    apply(value);
    return true;
  }

  function sync(userId, serverPref) {
    if (!hasUser(userId)) return null;
    write(PREFIX + ':last-user', String(userId));
    var key = keyFor(userId);
    var local = normalize(read(key));
    var pending = read(key + ':pending') === '1';
    var server = normalize(serverPref);

    if (pending && local) {        // the worker's last choice never reached the server: keep it and ask the app to retry
      apply(local);
      return local;
    }
    if (server) {                  // normal case: the profile is the source of truth
      write(key, server);
      apply(server);
      return null;
    }
    // the profile has no value yet: keep a choice made on this computer, otherwise System
    apply(local || 'system');
    return local;                  // if there is a local choice, the app should save it to the profile
  }

  function markSaved(userId) { if (hasUser(userId)) remove(keyFor(userId) + ':pending'); }

  // Before sign-in: the last signed-in user's choice on this computer, else the signed-out choice, else System.
  var lastUser = read(PREFIX + ':last-user');
  apply(read(keyFor(lastUser)) || read(keyFor(null)) || 'system');

  // System follows the computer's setting live (for example when Windows or macOS switches at night).
  if (mq) {
    var onSystemChange = function () { if (current === 'system') apply('system'); };
    if (mq.addEventListener) { mq.addEventListener('change', onSystemChange); } else if (mq.addListener) { mq.addListener(onSystemChange); }
  }

  // Keep other open tabs in step when the choice changes in one of them.
  window.addEventListener('storage', function (e) {
    if (!e.key || e.key.indexOf(PREFIX + ':') !== 0 || /:pending$/.test(e.key) || e.key === PREFIX + ':last-user') return;
    var who = read(PREFIX + ':last-user');
    if (e.key === keyFor(who)) apply(e.newValue || 'system');
  });

  window.NewayAppearance = {
    /** The saved choice: 'light' | 'dark' | 'system' */
    get: function () { return current; },
    /** The theme on screen now: 'light' | 'dark' */
    theme: function () { return document.documentElement.getAttribute('data-theme'); },
    /** The worker changed the setting. Returns false for an invalid value. */
    set: setChoice,
    /** The signed-in user's profile loaded. Returns a value the app should (re)save, or null. */
    sync: sync,
    /** The server confirmed the save. */
    markSaved: markSaved
  };
})();
