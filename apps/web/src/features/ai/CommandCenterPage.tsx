import { useQuery } from '@tanstack/react-query';
import { Bot, Fuel, Sparkles } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { demoCurrentUser, listAiInsights, type AiInsight } from '@/demo';
import { now as clockNow } from '@/lib/clock';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardSkeleton,
  EmptyState,
  ErrorState,
  FormField,
  Input,
  KpiCard,
  KpiSkeleton,
  Modal,
  PageHeader,
  SectionLabel,
  Timeline,
  useToast,
} from '@/design-system';
import { COMPANY_TIMEZONE, LOCALE, formatNumber, formatRelative } from '@/lib/format';

const DEPARTMENT_LABEL: Record<AiInsight['department'], string> = {
  dispatch: 'Dispatch',
  safety: 'Safety',
  maintenance: 'Maintenance',
  accounting: 'Accounting',
  hr: 'HR',
  fleet: 'Fleet',
  management: 'Management',
};

const SEVERITY_TONE = {
  critical: 'danger',
  warning: 'warning',
  info: 'info',
  success: 'success',
} as const;

const USAGE = { tokensUsed: 1_240_000, tokenCap: 3_000_000 };

function greeting(now: Date): string {
  const hour = Number(
    new Intl.DateTimeFormat(LOCALE, {
      hour: 'numeric',
      hour12: false,
      timeZone: COMPANY_TIMEZONE,
    }).format(now),
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function deltaFromTitle(title: string): number {
  const match = /([+-]?\d+(?:\.\d+)?)%/.exec(title);
  return match ? Number(match[1]) : 0;
}

function firstSentence(text: string): string {
  const end = text.indexOf('. ');
  return end === -1 ? text : text.slice(0, end + 1);
}

function actionTitle(insight: AiInsight): string {
  switch (insight.kind) {
    case 'truck.mpg_drop':
      return `Review ${insight.scope.label} fuel efficiency`;
    case 'driver.safety_trend':
      return `Coach ${insight.scope.label} on speeding`;
    case 'ar.aging':
      return `Collect past-due balance from ${insight.scope.label}`;
    case 'truck.pm_due':
      return 'Schedule overdue maintenance';
    case 'document.expiring':
      return 'Renew expiring driver documents';
    case 'load.late_risk':
      return `Protect delivery on ${insight.scope.label}`;
    default:
      return insight.title;
  }
}

interface Approval {
  id: string;
  title: string;
  detail: string;
}

function proposedApprovals(insights: AiInsight[]): Approval[] {
  const byKind = (kind: AiInsight['kind']) => insights.find((i) => i.kind === kind);
  const list: Approval[] = [];
  const docs = byKind('document.expiring');
  if (docs)
    list.push({
      id: `${docs.id}-approval`,
      title: `Send renewal reminders to ${docs.evidence.length} drivers`,
      detail: 'Driver-portal message with the expiry date and the DOT physical booking link.',
    });
  const pm = byKind('truck.pm_due');
  if (pm)
    list.push({
      id: `${pm.id}-approval`,
      title: 'Book Unit 2785 brake inspection at Lone Star Fleet Service',
      detail: 'Sep 8, after the Dallas delivery; 1 day estimated downtime.',
    });
  const ar = byKind('ar.aging');
  if (ar)
    list.push({
      id: `${ar.id}-approval`,
      title: `Email statement to ${ar.scope.label}`,
      detail: 'Lists open invoices and the one past due; copies the accounting inbox.',
    });
  return list.slice(0, 3);
}

export function CommandCenterPage() {
  const insights = useQuery({ queryKey: ['ai-insights'], queryFn: () => listAiInsights() });
  const [askOpen, setAskOpen] = useState(false);
  const [question, setQuestion] = useState('');

  const open = (insights.data ?? []).filter((i) => i.status !== 'closed');
  const departments = new Set(open.map((i) => i.department)).size;
  const description = insights.isPending
    ? 'Checking loads, trucks, drivers and money…'
    : `${open.length} ${open.length === 1 ? 'item requires' : 'items require'} attention across ${departments} ${departments === 1 ? 'department' : 'departments'}.`;

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <div className="rounded-lg border border-primary-border bg-primary-soft px-5 py-4">
        <PageHeader
          title={`${greeting(clockNow())}, ${demoCurrentUser.firstName}`}
          description={description}
          meta={
            <span aria-hidden className="text-primary [&_svg]:size-4">
              <Sparkles />
            </span>
          }
          actions={
            <Button variant="secondary" icon={<Bot />} onClick={() => setAskOpen(true)}>
              Ask AI
            </Button>
          }
        />
      </div>

      {insights.isError ? (
        <div className="rounded-lg border border-line bg-surface">
          <ErrorState
            title="Unable to load insights"
            description="The detectors could not be reached. Try again in a moment."
            error={insights.error}
            onRetry={() => void insights.refetch()}
            retrying={insights.isFetching}
          />
        </div>
      ) : insights.isPending ? (
        <div className="grid grid-cols-1 gap-(--section-gap) xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-4">
            <CardSkeleton lines={3} />
            <div className="grid grid-cols-2 gap-4">
              <KpiSkeleton />
              <KpiSkeleton />
            </div>
            <CardSkeleton lines={5} />
          </div>
          <div className="flex flex-col gap-4">
            <CardSkeleton lines={3} />
            <CardSkeleton lines={4} />
          </div>
        </div>
      ) : (
        <CommandCenterBody insights={insights.data} />
      )}

      <Modal
        open={askOpen}
        onOpenChange={setAskOpen}
        title="Ask AI"
        description="Ask a question about the operation in plain language."
        footer={
          <Button variant="secondary" onClick={() => setAskOpen(false)}>
            Close
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <FormField label="Question">
            <Input
              prefix={<Sparkles />}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask about loads, trucks, drivers, fuel, money…"
            />
          </FormField>
          <Alert
            tone="neutral"
            description="The assistant arrives in Phase 14; this preview shows the layout."
          />
        </div>
      </Modal>
    </div>
  );
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <SectionLabel>{label}</SectionLabel>
      {children}
    </section>
  );
}

function CommandCenterBody({ insights }: { insights: AiInsight[] }) {
  const { toast } = useToast();
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [decided, setDecided] = useState<Set<string>>(new Set());

  const revenue = insights.find((i) => i.kind === 'company.profit_change');
  const fuel = insights.find((i) => i.kind === 'company.fuel_cost');
  const recommendations = insights.filter(
    (i) =>
      [
        'truck.mpg_drop',
        'driver.safety_trend',
        'ar.aging',
        'truck.recurring_defect',
        'fuel.anomaly',
      ].includes(i.kind) && !dismissed.has(i.id),
  );
  const approvals = proposedApprovals(insights).filter((a) => !decided.has(a.id));
  const activity = [...insights].sort((a, b) => b.openedAt.localeCompare(a.openedAt)).slice(0, 6);

  const usagePercent = Math.round((USAGE.tokensUsed / USAGE.tokenCap) * 100);

  return (
    <div className="grid grid-cols-1 gap-(--section-gap) xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
      <div className="flex flex-col gap-(--section-gap)">
        {/* No "Critical" restatement here. This page derived its own counts of at-risk
            loads, overdue maintenance and expiring documents from a different dataset than
            the attention queue, the fleet exception engine and the compliance engine - two
            sources of truth for the same number, on a page that cannot act on either. Late
            freight lives on Loads, maintenance on Fleet, expiry on Safety. */}
        <Section label="Financial">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            {revenue ? (
              <div className="flex flex-col gap-2">
                <KpiCard
                  label="Revenue · August"
                  value={revenue.evidence[0]?.value ?? '—'}
                  delta={{ value: deltaFromTitle(revenue.title), label: 'vs last month' }}
                />
                <p className="text-xs text-secondary">{firstSentence(revenue.detail)}</p>
              </div>
            ) : null}
            {fuel ? (
              <div className="flex flex-col gap-2">
                <KpiCard
                  label="Fuel cost · last 4 weeks"
                  value={fuel.evidence[0]?.value ?? '—'}
                  icon={<Fuel />}
                  delta={{
                    value: deltaFromTitle(fuel.title),
                    label: 'vs prior 4 weeks',
                    positiveIsGood: false,
                  }}
                />
                <p className="text-xs text-secondary">{firstSentence(fuel.detail)}</p>
              </div>
            ) : null}
          </div>
        </Section>

        <Section label="Recommendations">
          {recommendations.length ? (
            <div className="flex flex-col gap-3">
              {recommendations.map((insight) => (
                <RecommendationCard
                  key={insight.id}
                  insight={insight}
                  onCreateTask={() =>
                    toast({
                      tone: 'success',
                      title: 'Task created',
                      description: `${actionTitle(insight)} · assigned to ${DEPARTMENT_LABEL[insight.department]}.`,
                    })
                  }
                  onDismiss={() => {
                    setDismissed((set) => new Set(set).add(insight.id));
                    toast({
                      tone: 'info',
                      title: 'Recommendation dismissed',
                      description: 'It returns if the signal persists next week.',
                    });
                  }}
                />
              ))}
            </div>
          ) : (
            <Card>
              <EmptyState
                size="sm"
                icon={<Sparkles />}
                title="No open recommendations"
                description="New recommendations appear as the detectors find patterns."
              />
            </Card>
          )}
        </Section>
      </div>

      <div className="flex flex-col gap-(--section-gap)">
        <Card
          title="Pending approvals"
          description="Actions the assistant proposed; nothing runs without approval."
        >
          {approvals.length ? (
            <ul className="flex flex-col">
              {approvals.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-col gap-2 border-b border-line-soft py-3 first:pt-0 last:border-b-0 last:pb-0"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-ink">{a.title}</div>
                      <p className="mt-0.5 text-xs text-muted">{a.detail}</p>
                    </div>
                    <Badge tone="violet" size="sm" variant="outline">
                      require_approval
                    </Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() => {
                        setDecided((set) => new Set(set).add(a.id));
                        toast({ tone: 'success', title: 'Approved', description: a.title });
                      }}
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setDecided((set) => new Set(set).add(a.id));
                        toast({ tone: 'info', title: 'Rejected', description: a.title });
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState size="sm" title="No approvals waiting" />
          )}
        </Card>

        <Card title="AI activity" description="Recent detections, newest first.">
          <Timeline
            dense
            items={activity.map((i) => ({
              id: i.id,
              at: i.openedAt,
              title: i.title,
              description: `${DEPARTMENT_LABEL[i.department]} · ${i.detector}`,
              tone: SEVERITY_TONE[i.severity],
            }))}
            formatTime={(d) => formatRelative(d, { now: clockNow() })}
          />
        </Card>

        <Card title="Usage" description="Assistant tokens this month.">
          <div className="flex items-baseline justify-between text-sm">
            <span className="tabular font-medium text-ink">
              {formatNumber(USAGE.tokensUsed / 1_000_000, 2)}M
            </span>
            <span className="tabular text-xs text-muted">
              of {formatNumber(USAGE.tokenCap / 1_000_000, 0)}M · {usagePercent}%
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Token usage"
            aria-valuemin={0}
            aria-valuemax={USAGE.tokenCap}
            aria-valuenow={USAGE.tokensUsed}
            className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-nw-track"
          >
            <div className="h-full rounded-full bg-nw-chart-1" style={{ width: `${usagePercent}%` }} />
          </div>
          <p className="mt-2 text-xs text-muted">
            Resets Oct 1. Cap is set under Admin › Settings.
          </p>
        </Card>
      </div>
    </div>
  );
}

function RecommendationCard({
  insight,
  onCreateTask,
  onDismiss,
}: {
  insight: AiInsight;
  onCreateTask: () => void;
  onDismiss: () => void;
}) {
  const confidence = Math.round(insight.confidence * 100);
  const confidenceTone = confidence >= 85 ? 'success' : confidence >= 70 ? 'info' : 'warning';
  const stripped = insight.rationale.replace(/^WHY:\s*/i, '');
  const rationale = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-md font-bold text-ink">{actionTitle(insight)}</h3>
          <p className="mt-0.5 text-sm text-secondary">{insight.recommendation}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Badge tone={SEVERITY_TONE[insight.severity]} size="sm" dot>
            {DEPARTMENT_LABEL[insight.department]}
          </Badge>
          <Badge tone={confidenceTone} size="sm" className="tabular">
            {confidence}% confidence
          </Badge>
        </div>
      </div>
      <div className="mt-3 rounded-md border border-line bg-surface p-3">
        <div className="eyebrow">Why</div>
        <p className="mt-1 text-sm text-secondary">{rationale}</p>
        <ul className="mt-2 flex flex-col gap-1 text-sm text-ink">
          {insight.evidence.map((e) => (
            <li key={`${e.label}-${e.value}`} className="flex gap-2">
              <span aria-hidden className="mt-2 size-1 shrink-0 rounded-full bg-muted" />
              <span>
                <span className="text-muted">{e.label}: </span>
                <span className="tabular">{e.value}</span>
              </span>
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <Button variant="primary" size="sm" onClick={onCreateTask}>
          Create task
        </Button>
        <Button variant="secondary" size="sm" onClick={onDismiss}>
          Dismiss
        </Button>
        <span className="ml-auto text-xs text-muted">
          Detected {formatRelative(insight.openedAt, { now: clockNow() })}
        </span>
      </div>
    </Card>
  );
}
