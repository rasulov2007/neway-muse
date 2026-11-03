import { DICTIONARIES } from './dictionaries';
import { LANGUAGES, setCurrentLang, t, tn } from './core';

afterEach(() => setCurrentLang('en'));

test('English is the source: the text comes back with its placeholders filled', () => {
  expect(t('Use {label} next time?', { label: 'Face ID' })).toBe('Use Face ID next time?');
  expect(tn(1, '{count} page', '{count} pages')).toBe('1 page');
  expect(tn(3, '{count} page', '{count} pages')).toBe('3 pages');
});

test('a string with no translation yet stays English, never a key', () => {
  setCurrentLang('ru');
  expect(t('A sentence nobody has translated')).toBe('A sentence nobody has translated');
});

test('every language but English has a dictionary, and every translation keeps its placeholders', () => {
  for (const { code } of LANGUAGES) {
    if (code === 'en') continue;
    const dict = DICTIONARIES[code];
    expect(dict).toBeDefined();
    for (const [en, tr] of Object.entries(dict ?? {})) {
      const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect({ en, names: names(tr) }).toEqual({ en, names: names(en) });
      expect(tr.trim()).not.toBe('');
    }
  }
});

test('the login tagline is translated in every language', () => {
  for (const { code } of LANGUAGES) {
    if (code === 'en') continue;
    setCurrentLang(code);
    expect(t('Trucking, on time. Every mile.')).not.toBe('Trucking, on time. Every mile.');
  }
});
