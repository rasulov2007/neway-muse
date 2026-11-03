import { createFileRoute } from '@tanstack/react-router';
import { VendorsPage } from '@/features/fleet/VendorsPage';

export const Route = createFileRoute('/fleet/vendors/')({
  component: VendorsPage,
});
