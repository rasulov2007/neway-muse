import { createFileRoute } from '@tanstack/react-router';
import { SettlementDetailRoute } from '@/features/accounting/SettlementDetailPage';

export const Route = createFileRoute('/accounting/settlements/$settlementId')({
  component: SettlementDetailRoute,
});
