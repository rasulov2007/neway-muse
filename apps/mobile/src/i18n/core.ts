import { DICTIONARIES } from './dictionaries';

/**
 * The app's languages (owner, 2026-10-28). English is the source and the default; every other
 * language is a dictionary from the English text to its translation, so a string that has not been
 * translated yet shows in English rather than as a key.
 *
 *   t('Welcome back')
 *   t('Use {label} next time?', { label })
 *
 * This file has no React Native imports, so plain modules (the upload queue, its tests) can use it.
 */
export const LANGUAGES = [
  { code: 'en', name: 'English', native: 'English', hello: 'Hello' },
  { code: 'uz', name: 'Uzbek', native: "O'zbekcha", hello: 'Salom' },
  { code: 'ru', name: 'Russian', native: 'Русский', hello: 'Здравствуйте' },
  { code: 'es', name: 'Spanish', native: 'Español', hello: 'Hola' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe', hello: 'Merhaba' },
  { code: 'kk', name: 'Kazakh', native: 'Қазақша', hello: 'Сәлеметсіз бе' },
] as const;

export type Lang = (typeof LANGUAGES)[number]['code'];

const LANG_CODES = LANGUAGES.map((l) => l.code) as readonly string[];
export function isLang(v: unknown): v is Lang {
  return typeof v === 'string' && LANG_CODES.includes(v);
}

let current: Lang = 'en';

export function currentLang(): Lang {
  return current;
}

/** The provider (and tests) switch the live language here. */
export function setCurrentLang(lang: Lang): void {
  current = lang;
}

function fill(text: string, vars?: Record<string, string | number | null | undefined>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (vars[k] === undefined || vars[k] === null ? m : String(vars[k])));
}

/** Translates an English UI string into the live language; English when there is no translation. */
export function t(english: string, vars?: Record<string, string | number | null | undefined>): string {
  const translated = current === 'en' ? undefined : DICTIONARIES[current]?.[english];
  return fill(translated ?? english, vars);
}

/** "1 page" / "3 pages": the English singular and plural (each with {count}), translated. */
export function tn(count: number, one: string, many: string, vars?: Record<string, string | number>): string {
  return t(count === 1 ? one : many, { count, ...vars });
}

/** The BCP 47 tag for Intl (dates, numbers) in the live language. */
export function locale(): string {
  return { en: 'en-US', uz: 'uz-Latn-UZ', ru: 'ru-RU', es: 'es-US', tr: 'tr-TR', kk: 'kk-KZ' }[current];
}
