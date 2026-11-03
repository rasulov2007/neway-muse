import { Redirect, Stack } from 'expo-router';

import { useSession } from '@/auth/session';
import { color } from '@/ui/tokens';

/** The Driver shell: only for a signed-in person holding driver_app.use. */
export default function DriverLayout() {
  const { state, canDrive } = useSession();
  if (state.status === 'booting') return null;
  if (state.status === 'locked') return <Redirect href="/" />;
  if (state.status !== 'signedIn') return <Redirect href="/login" />;
  if (state.account.mustChangePassword) return <Redirect href="/change-password" />;
  if (!canDrive) return <Redirect href="/office/today" />;
  return (
    <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }}>
      <Stack.Screen name="assistant" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
    </Stack>
  );
}
