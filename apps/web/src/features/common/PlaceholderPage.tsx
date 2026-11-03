import { Construction } from 'lucide-react';
import { EmptyState, PageHeader } from '@/design-system';
import { NAV_PAGES } from '@/app/navigation';

interface PlaceholderPageProps {
  /** Route path; label, group and roadmap phase are looked up from the navigation config. */
  to: string;
  phase?: number;
}

/**
 * Designed stand-in for a module a later roadmap phase delivers. Keeps the shell and page header
 * real so navigation can be exercised end to end.
 */
export function PlaceholderPage({ to, phase }: PlaceholderPageProps) {
  const page = NAV_PAGES.find((p) => p.to === to);
  const title = page?.label ?? 'Page';
  const phaseLabel = phase ? `Phase ${phase}` : 'a later phase';

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title={title}
        description={`${title} is planned for ${phaseLabel} of the roadmap.`}
      />
      <div className="rounded-lg border border-line bg-surface">
        <EmptyState
          icon={<Construction />}
          title={`${title} arrives in ${phaseLabel}`}
          description="The navigation, layout and design system are in place. This module's data model and screens are built in its roadmap phase using the same components."
        />
      </div>
    </div>
  );
}
