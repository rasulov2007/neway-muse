import { Redirect } from 'expo-router';
import { View } from 'react-native';

import { useSession } from '@/auth/session';
import { LockScreen } from '@/features/biometric-sheet';
import { LoadingState } from '@/ui/states';
import { color } from '@/ui/tokens';

/**
 * Where a person lands: the Face ID lock, login, the temporary-password gate, or their shell.
 * No intro before it (owner, 2026-10-28): the app opens straight on the login page, or straight in.
 */
export default function Index() {
  const { state, shell } = useSession();
  if (state.status === 'booting') {
    return (
      <View style={{ flex: 1, justifyContent: 'center', backgroundColor: color.background }}>
        <LoadingState />
      </View>
    );
  }
  if (state.status === 'locked') return <LockScreen />;
  if (state.status === 'signedOut') return <Redirect href="/login" />;
  if (state.account.mustChangePassword) return <Redirect href="/change-password" />;
  return <Redirect href={shell === 'driver' ? '/driver/today' : '/office/today'} />;
}
