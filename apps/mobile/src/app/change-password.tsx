import { PASSWORD_MIN_LENGTH } from '@neway/shared/auth/index';
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ApiError, api } from '@/api/client';
import { routes } from '@/api/contract';
import { useSession } from '@/auth/session';
import { t } from '@/i18n';
import { Button, TextField } from '@/ui/controls';
import { Logo, Text } from '@/ui/primitives';
import { color, gutter, space } from '@/ui/tokens';

/** The temporary-password gate: nothing else opens until the person picks their own. */
export default function ChangePassword() {
  const { state, passwordChanged, logout } = useSession();
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (state.status !== 'signedIn') return <Redirect href="/login" />;

  const submit = async () => {
    if (next.length < PASSWORD_MIN_LENGTH) return setError(t('Use at least {count} characters.', { count: PASSWORD_MIN_LENGTH }));
    if (next !== confirm) return setError(t('The two passwords do not match.'));
    setBusy(true);
    setError(null);
    try {
      await api.post(routes.temporaryPassword, { newPassword: next, confirmPassword: confirm });
      passwordChanged();
      router.replace('/');
    } catch (e) {
      setError(e instanceof ApiError ? (e.detail ?? e.title) : t('Could not save the password.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: color.background }}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: gutter, gap: space.lg }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
          <Logo />
          <Text variant="smallStrong">NeWay TMS</Text>
        </View>
        <View style={{ gap: space.xs }}>
          <Text variant="title">{t('Choose your password')}</Text>
          <Text variant="small" tint={color.text2}>
            {t('You signed in with a temporary password. Pick your own — at least {count} characters — to continue.', { count: PASSWORD_MIN_LENGTH })}
          </Text>
        </View>
        <TextField label={t('New password')} value={next} onChangeText={setNext} secureTextEntry autoComplete="new-password" textContentType="newPassword" />
        <TextField
          label={t('Repeat the new password')}
          value={confirm}
          onChangeText={setConfirm}
          secureTextEntry
          autoComplete="new-password"
          error={error}
          onSubmitEditing={submit}
        />
        <Button label={t('Save password')} onPress={submit} loading={busy} />
        <Button label={t('Sign out')} variant="outline" onPress={() => void logout().then(() => router.replace('/login'))} />
      </ScrollView>
    </SafeAreaView>
  );
}
