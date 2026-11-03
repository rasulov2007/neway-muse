import {
  ONBOARDING_OWNER_ROLE_LABELS,
  type OnboardingOwnerRole,
  type OnboardingTemplate,
} from '@neway/shared';
import { BackButton, Alert, Badge, Card, EmptyState, PageHeader, Skeleton } from '@/design-system';
import { useOnboardingTemplates } from './useHr';

/**
 * The plans a hire gets, read-only: one per driver type, each item with its owner, its due
 * offset, whether it blocks the driver from becoming active, and whether it completes from the
 * qualification file rather than by hand. The hire event picks the template by driver type.
 */
export function OnboardingTemplatesPage() {
  const templates = useOnboardingTemplates();
  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Onboarding templates"
        description="What a new hire's plan contains. Blocking items hold a driver at Hired; file-linked items complete from the qualification file."
        back={<BackButton fallback="/hr/onboarding" />}
      />
      {templates.isPending ? (
        <Skeleton className="h-64 w-full" />
      ) : templates.error ? (
        <Alert tone="danger" title="Templates could not be loaded" />
      ) : (templates.data ?? []).length === 0 ? (
        <EmptyState
          title="No templates"
          description="Hires get the built-in role-aware item list until templates are installed."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-3">
          {(templates.data ?? []).map((t) => (
            <TemplateCard key={t.id} template={t} />
          ))}
        </div>
      )}
    </div>
  );
}

function TemplateCard({ template }: { template: OnboardingTemplate }) {
  const blocking = template.items.filter((i) => i.blocking).length;
  return (
    <Card
      title={template.name}
      description={`${template.items.length} items · ${blocking} blocking${template.driverType ? ` · ${template.driverType.replace(/_/g, ' ')}` : ''}${template.isDefault ? ' · default' : ''}`}
      padding="none"
    >
      <ul className="divide-y divide-line-soft">
        {template.items.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
            <span className="min-w-0">
              <span className="block text-sm text-ink">{item.title}</span>
              <span className="block text-xs text-muted">
                {item.category} · due day {item.dueOffsetDays}
                {item.ownerRole
                  ? ` · ${ONBOARDING_OWNER_ROLE_LABELS[item.ownerRole as OnboardingOwnerRole] ?? item.ownerRole}`
                  : ''}
              </span>
            </span>
            <span className="flex shrink-0 gap-1">
              {item.blocking ? (
                <Badge tone="warning" size="sm" variant="outline">
                  blocking
                </Badge>
              ) : null}
              {item.requirementCode ? (
                <Badge tone="info" size="sm" variant="outline" title={item.requirementCode}>
                  from file
                </Badge>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
