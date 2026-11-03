import { Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold, useFonts } from '@expo-google-fonts/manrope';
import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { LogBox, Platform } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { SessionProvider, useSession } from '@/auth/session';
import { LanguageProvider } from '@/i18n';
import { RestorePlace } from '@/lib/keep-place';
import { usePushRouting } from '@/lib/push';
import { QueueProvider } from '@/offline/queue';
import { ToastProvider } from '@/ui/layout';
import { setFontsReady } from '@/ui/primitives';
import { ThemeProvider, useTheme } from '@/ui/theme';
import { color } from '@/ui/tokens';

// react-native-web hands Animated's `collapsable` prop to SVG elements in the web preview only.
if (Platform.OS === 'web') LogBox.ignoreLogs([/non-boolean attribute/, 'Received `%s` for a non-boolean attribute', 'Received `false` for a non-boolean attribute']);

/** Push taps open their record once someone is signed in (and past the temporary password). */
function PushRouting() {
  const { state, shell } = useSession();
  const ready = state.status === 'signedIn' && !state.account.mustChangePassword;
  usePushRouting(ready ? shell : null);
  return null;
}

function Themed() {
  const { scheme } = useTheme();
  return (
    <ToastProvider>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <PushRouting />
      <RestorePlace />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }} />
    </ToastProvider>
  );
}

export default function RootLayout() {
  // Manrope (Porcelain SPEC §5). A slow or failed font load never holds the app: after a moment
  // it opens with the system font.
  const [loaded, error] = useFonts({ Manrope_400Regular, Manrope_500Medium, Manrope_600SemiBold, Manrope_700Bold, Manrope_800ExtraBold });
  const [gaveUp, setGaveUp] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setGaveUp(true), 2500);
    return () => clearTimeout(t);
  }, []);
  setFontsReady(Boolean(loaded && !error));
  if (!loaded && !error && !gaveUp) return null;
  return (
    <SafeAreaProvider>
      <QueueProvider>
        <SessionProvider>
          <ThemeProvider>
            <LanguageProvider>
              <Themed />
            </LanguageProvider>
          </ThemeProvider>
        </SessionProvider>
      </QueueProvider>
    </SafeAreaProvider>
  );
}
