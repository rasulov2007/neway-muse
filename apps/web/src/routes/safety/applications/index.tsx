import { createFileRoute } from '@tanstack/react-router';
import { DotAppQueuePage } from '@/features/safety/dot-applications/DotAppReviewPage';

export const Route = createFileRoute('/safety/applications/')({
  component: DotAppQueuePage,
});
