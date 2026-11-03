import { Redirect } from 'expo-router';

import { LockScreen } from '@/features/biometric-sheet';

/** Development only: the Face ID lock drawn without asking the phone (screenshots on the web build). */
export default function DevLock() {
  if (!__DEV__) return <Redirect href="/" />;
  return <LockScreen preview />;
}
