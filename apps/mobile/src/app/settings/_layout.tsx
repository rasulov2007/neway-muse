import { Redirect, Stack } from 'expo-router';
import { View } from 'react-native';

import { useSession } from '@/auth/session';
import { ChangesBar, SettingsProvider } from '@/features/settings';
import { color } from '@/ui/tokens';

/** Settings for every signed-in person (Driver and Office): one staged draft across its pages. */
export default function SettingsLayout() {
  const { state } = useSession();
  if (state.status === 'booting') return null;
  if (state.status !== 'signedIn') return <Redirect href="/" />;
  return (
    <SettingsProvider>
      <View style={{ flex: 1 }}>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.canvas } }} />
        <ChangesBar />
      </View>
    </SettingsProvider>
  );
}
