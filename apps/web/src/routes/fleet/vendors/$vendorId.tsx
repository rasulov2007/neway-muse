import { createFileRoute } from '@tanstack/react-router';
import { VendorDetailRoute } from '@/features/fleet/VendorsPage';

export const Route = createFileRoute('/fleet/vendors/$vendorId')({
  component: VendorDetailRoute,
});
