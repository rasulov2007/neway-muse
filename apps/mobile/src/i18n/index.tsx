import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { useRememberPlace } from '@/lib/keep-place';
import { draftStore } from '@/offline/db';

import { currentLang, isLang, setCurrentLang, type Lang } from './core';

export { LANGUAGES, currentLang, isLang, locale, t, tn, type Lang } from './core';

/**
 * The language provider. The choice belongs to this phone (kept in the drafts table, like the
 * appearance before sign-in) and applies at once: it swaps the live language and redraws the tree
 * below it, the same way the theme swaps its tokens; the page the person is on is kept.
 */
interface LanguageApi {
  lang: Lang;
  setLang(next: Lang): void;
}

const APP_SCOPE = '_app';
const KEY = 'language';
const LanguageContext = createContext<LanguageApi | null>(null);
/** The saved choice has been read once this launch (a redraw of the theme must not wait for it again). */
let loaded = false;

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(currentLang());
  const [ready, setReady] = useState(loaded);
  const rememberPlace = useRememberPlace();

  useEffect(() => {
    if (loaded) return;
    let alive = true;
    // A slow phone database never holds the app: after a moment it opens in English.
    const t0 = setTimeout(() => alive && setReady(true), 600);
    draftStore
      .get<string>(APP_SCOPE, KEY)
      .then((saved) => {
        if (!alive) return;
        if (isLang(saved)) {
          setCurrentLang(saved);
          setLangState(saved);
        }
      })
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(t0);
        loaded = true;
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
      clearTimeout(t0);
    };
  }, []);

  const setLang = useCallback(
    (next: Lang) => {
      rememberPlace();
      setCurrentLang(next);
      setLangState(next);
      void draftStore.set(APP_SCOPE, KEY, next).catch(() => undefined);
    },
    [rememberPlace],
  );

  if (currentLang() !== lang) setCurrentLang(lang);
  const value = useMemo<LanguageApi>(() => ({ lang, setLang }), [lang, setLang]);
  if (!ready) return null;
  return (
    <LanguageContext.Provider value={value}>
      <View key={lang} style={{ flex: 1 }}>
        {children}
      </View>
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageApi {
  const v = useContext(LanguageContext);
  if (!v) throw new Error('useLanguage outside LanguageProvider');
  return v;
}
