import { SearchX } from 'lucide-react';
import { EmptyState } from '@/design-system';

export function NotFound() {
  return (
    <div className="rounded-lg border border-line bg-surface">
      <EmptyState
        icon={<SearchX />}
        title="Page not found"
        description="The page you are looking for does not exist or has moved."
      />
    </div>
  );
}
