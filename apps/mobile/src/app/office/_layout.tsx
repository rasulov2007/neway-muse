import { Redirect, Stack } from 'expo-router';

import { useSession } from '@/auth/session';
import { color } from '@/ui/tokens';

/** The Office shell: every signed-in person with an office permission. */
export default function OfficeLayout() {
  const { state, canOffice } = useSession();
  if (state.status === 'booting') return null;
  if (state.status === 'locked') return <Redirect href="/" />;
  if (state.status !== 'signedIn') return <Redirect href="/login" />;
  if (state.account.mustChangePassword) return <Redirect href="/change-password" />;
  if (!canOffice) return <Redirect href="/driver/today" />;
  return <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: color.background } }} />;
}
