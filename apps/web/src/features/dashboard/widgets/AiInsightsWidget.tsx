import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Info, OctagonAlert, Sparkles, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Card, CardSkeleton, EmptyState, ErrorState } from '@/design-system';
import { listAiInsights, type AiInsight, type Severity } from '@/demo';
import { RouterLink } from '../RouterLink';
import { hrefs, viewAllClass } from '../links';
import { DemoBadge } from './WidgetFrame';

const ROWS = 5;

const severityIcon: Record<Severity, ReactNode> = {
  critical: <OctagonAlert className="text-danger" />,
  warning: <TriangleAlert className="text-warning" />,
  info: <Info className="text-info" />,
  success: <Info className="text-success" />,
};

const SEVERITY_RANK: Record<Severity, number> = { critical: 0, warning: 1, info: 2, success: 3 };

function firstSentence(text: string): string {
  const match = /^(.*?[.!?])(\s|$)/.exec(text);
  return match?.[1] ?? text;
}

/**
 * Open AI insights from the web demo API (labeled demo) with a link to the AI Command Center.
 *
 * Removed from the dashboard on 2026-09-08 at the owner's request; it is to be mounted on another
 * surface (notifications was the example given), so it is kept whole and self-contained — it owns
 * its own query and needs no props. The full list already lives on the AI Command Center page.
 */
export function AiInsightsWidget() {
  const query = useQuery({
    queryKey: ['dashboard', 'ai-insights'],
    queryFn: () => listAiInsights(),
  });

  const insights: AiInsight[] = [...(query.data ?? [])]
    .filter((i) => i.status !== 'closed')
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, ROWS);

  return (
    <Card
      title={
        <span className="inline-flex items-center gap-2">
          <Sparkles aria-hidden className="size-4 text-violet" />
          AI insights
          <DemoBadge />
        </span>
      }
      description="What the detectors think you should look at"
      padding="none"
      className="min-w-0"
      data-testid="ai-insights-widget"
      footer={
        <RouterLink to={hrefs.ai} className={viewAllClass}>
          Open AI Command Center
          <ArrowRight aria-hidden className="size-3.5" />
        </RouterLink>
      }
    >
      {query.isPending ? (
        <div className="p-(--card-padding)">
          <CardSkeleton lines={4} />
        </div>
      ) : query.isError ? (
        <ErrorState
          size="sm"
          title="Unable to load insights"
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : insights.length === 0 ? (
        <EmptyState
          size="sm"
          icon={<Sparkles />}
          title="No open insights"
          description="New findings appear here as the detectors run."
        />
      ) : (
        <ul className="flex flex-col divide-y divide-line-soft">
          {insights.map((insight) => (
            <li key={insight.id} className="flex items-start gap-2.5 px-(--card-padding) py-2">
              <span aria-hidden className="mt-0.5 shrink-0 [&_svg]:size-4">
                {severityIcon[insight.severity]}
              </span>
              <div className="min-w-0 flex-1">
                <RouterLink
                  to={`${hrefs.ai}?insight=${encodeURIComponent(insight.id)}`}
                  className="block truncate text-sm font-medium text-ink hover:underline"
                >
                  <span className="sr-only">{insight.severity}: </span>
                  {insight.title}
                </RouterLink>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {firstSentence(insight.detail)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
