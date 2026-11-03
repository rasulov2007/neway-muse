import { createFileRoute } from '@tanstack/react-router';
import { DotAppReviewPage } from '@/features/safety/dot-applications/DotAppReviewPage';

export const Route = createFileRoute('/safety/applications/$applicationId')({
  component: ApplicationRoute,
});

function ApplicationRoute() {
  const { applicationId } = Route.useParams();
  return <DotAppReviewPage key={applicationId} applicationId={applicationId} />;
}
