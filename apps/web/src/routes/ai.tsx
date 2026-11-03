import { createFileRoute } from '@tanstack/react-router';
import { NeWayAiPage } from '@/features/ai-assistant/NeWayAiPage';

export const Route = createFileRoute('/ai')({
  component: NeWayAiPage,
});
