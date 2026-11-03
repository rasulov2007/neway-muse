import auth from './dict/auth';
import common from './dict/common';
import driverA from './dict/driver-a';
import driverB from './dict/driver-b';
import office from './dict/office';
import type { Fragment } from './fragment';

/**
 * Every translation, merged from the per-area fragments in ./dict (English text → translation).
 * A fragment is one file per area of the app so several people can translate at once.
 */
const FRAGMENTS: Fragment[] = [common, auth, driverA, driverB, office];

type Translated = 'uz' | 'ru' | 'es' | 'tr' | 'kk';

function merge(lang: Translated): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of FRAGMENTS) Object.assign(out, f[lang]);
  return out;
}

export const DICTIONARIES: Partial<Record<string, Record<string, string>>> = {
  uz: merge('uz'),
  ru: merge('ru'),
  es: merge('es'),
  tr: merge('tr'),
  kk: merge('kk'),
};
