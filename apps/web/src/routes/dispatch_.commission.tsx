import { createFileRoute } from '@tanstack/react-router';
import { CommissionPage } from '@/features/dispatch/board/CommissionPage';

export const Route = createFileRoute('/dispatch_/commission')({
  component: CommissionPage,
});
