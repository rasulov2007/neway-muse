import { useLocalSearchParams } from 'expo-router';

import { ConversationScreen } from '@/features/messaging';

/** Sheet 16 — one conversation. */
export default function Conversation() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ConversationScreen id={id} shell="driver" />;
}
