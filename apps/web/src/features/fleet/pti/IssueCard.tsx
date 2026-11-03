import { ChevronDown, ChevronUp, ImagePlus, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  PTI_DEFECT_SEVERITIES,
  PTI_DEFECT_SEVERITY_LABEL,
  screenshotRequired,
  type PtiDefectSeverity,
  type TelegramSource,
} from '@neway/shared';
import { PTI_RATING_LABEL, type PtiComponentDef } from '@/demo';
import { Badge, Button, DatePicker, FormField, IconButton, Input, Select, StatusBadge, Textarea, cn } from '@/design-system';
import { formatDate } from '@/lib/format';
import { uploadScreenshot } from './api';
import {
  NEXT_ACTION_LABEL,
  dueOffsetLabel,
  effectiveDueAt,
  previousRatingLabel,
  withSeverity,
  type IssueDraft,
  type NextAction,
  type ReviewContext,
} from './review-plan';

/**
 * One issue on the walk-around, in the fixed order the brief sets (§6.2 STEP 3): component,
 * what's wrong, severity, evidence, responsible, next action, due. Nothing about the truck, the
 * driver, the week or the source is asked again - those are the inspection's, inherited.
 */
export function IssueCard({
  issue,
  index,
  ctx,
  collapsed,
  onToggle,
  onChange,
  onRemove,
  uploadedBy,
}: {
  issue: IssueDraft;
  index: number;
  ctx: ReviewContext;
  collapsed: boolean;
  onToggle: () => void;
  onChange: (next: IssueDraft) => void;
  onRemove: () => void;
  uploadedBy: string;
}) {
  const component = ctx.components.find((c) => c.key === issue.component) ?? null;
  const title = `Issue ${index + 1}${component ? ` · ${component.name}` : ''}`;

  if (collapsed) {
    return (
      <section className="rounded-lg border border-line bg-surface p-3" aria-label={title}>
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="font-semibold text-ink">{component?.name ?? `Issue ${index + 1}`}</span>
            <span className="text-muted">
              {issue.description.trim() ? ` · ${issue.description.trim()}` : ' · no description yet'}
            </span>
          </span>
          <StatusBadge status={issue.severity} label={PTI_DEFECT_SEVERITY_LABEL[issue.severity]} size="sm" />
          <IconButton label={`Expand ${title}`} size="sm" variant="ghost" onClick={onToggle}>
            <ChevronDown />
          </IconButton>
        </div>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-line bg-surface p-3" aria-label={title}>
      <div className="flex items-center gap-2">
        <h3 className="min-w-0 flex-1 text-sm font-bold text-ink">{title}</h3>
        <IconButton label={`Remove ${title}`} size="sm" variant="ghost" onClick={onRemove}>
          <Trash2 />
        </IconButton>
        <IconButton label={`Collapse ${title}`} size="sm" variant="ghost" onClick={onToggle}>
          <ChevronUp />
        </IconButton>
      </div>

      {/* 1 · Component */}
      <FormField
        label="Component"
        required
        description={component ? (previousRatingLabel(component.id, ctx.conditions, PTI_RATING_LABEL) ?? 'not rated before') : undefined}
      >
        <Select
          aria-label={`${title} component`}
          value={issue.component ?? ''}
          onValueChange={(key) => onChange({ ...issue, component: key || null, quickPick: null })}
          placeholder="Choose the component"
          options={ctx.components.map((c) => ({ value: c.key ?? '', label: c.name }))}
        />
      </FormField>

      {/* 2 · What's wrong */}
      <FormField label="What's wrong" required description="A sentence the shop can act on. Numbers on their own are not one.">
        <div className="flex flex-col gap-2">
          {component && (component.quickPicks?.length ?? 0) > 0 ? (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Quick picks">
              {(component.quickPicks ?? []).map((pick) => {
                const on = issue.quickPick === pick;
                return (
                  <button
                    key={pick}
                    type="button"
                    aria-pressed={on}
                    className={cn(
                      'h-7 rounded-md border px-2.5 text-xs font-medium transition-colors',
                      on ? 'border-nw-accent bg-nw-selected text-ink' : 'border-line bg-surface text-secondary hover:bg-nw-hover',
                    )}
                    onClick={() =>
                      onChange({
                        ...issue,
                        quickPick: on ? null : pick,
                        // The chip is a start, not the whole story; it is put in the text to be finished.
                        description: on
                          ? issue.description
                          : issue.description.trim()
                            ? issue.description
                            : `${pick}${component ? ` — ${component.name.toLowerCase()}` : ''}`,
                      })
                    }
                  >
                    {pick}
                  </button>
                );
              })}
            </div>
          ) : null}
          <Textarea
            aria-label={`${title} description`}
            rows={2}
            value={issue.description}
            onChange={(event) => onChange({ ...issue, description: event.target.value })}
            placeholder="e.g. Slack adjuster out of stroke on axle 3, driver side"
          />
        </div>
      </FormField>

      {/* 3 · Severity */}
      <FormField label="Severity" description={`Due ${dueOffsetLabel(issue.severity)} · ${holdWord(issue.severity)}`}>
        <div role="group" aria-label={`${title} severity`} className="grid grid-cols-4 gap-1">
          {PTI_DEFECT_SEVERITIES.map((severity) => {
            const on = issue.severity === severity;
            return (
              <button
                key={severity}
                type="button"
                aria-pressed={on}
                className={cn(
                  'h-8 rounded-md border px-1 text-xs font-semibold transition-colors',
                  on ? SEVERITY_ON[severity] : 'border-line bg-surface text-secondary hover:bg-nw-hover',
                )}
                onClick={() => onChange(withSeverity(issue, severity, ctx))}
              >
                {SEVERITY_SHORT[severity]}
              </button>
            );
          })}
        </div>
      </FormField>

      {/* 4 · Evidence */}
      <Evidence issue={issue} source={ctx.inspection.source} onChange={onChange} uploadedBy={uploadedBy} />

      {/* 5 · Responsible */}
      <FormField label="Responsible" description={issue.ownerEdited ? 'Chosen by you' : 'By the routing rule; change it if you know better'}>
        <Select
          aria-label={`${title} owner`}
          value={issue.ownerId ?? ''}
          onValueChange={(id) => {
            const owner = ctx.assignees.find((a) => a.id === id) ?? null;
            onChange({ ...issue, ownerId: owner?.id ?? null, ownerName: owner?.name ?? null, ownerEdited: true });
          }}
          placeholder="Nobody yet"
          options={ctx.assignees.map((a) => ({ value: a.id, label: a.name }))}
        />
      </FormField>

      {/* 6 · Next action */}
      <FormField label="Next action">
        <div className="flex flex-col gap-2">
          <Select
            aria-label={`${title} next action`}
            value={issue.nextAction}
            onValueChange={(value) => onChange({ ...issue, nextAction: value as NextAction })}
            options={(Object.keys(NEXT_ACTION_LABEL) as NextAction[]).map((value) => ({ value, label: NEXT_ACTION_LABEL[value] }))}
          />
          {issue.nextAction === 'work_order' ? (
            <Input
              aria-label={`${title} vendor`}
              value={issue.vendorName}
              onChange={(event) => onChange({ ...issue, vendorName: event.target.value })}
              placeholder="Vendor or shop (optional)"
            />
          ) : null}
        </div>
      </FormField>

      {/* 7 · Due */}
      <FormField label="Due" description={issue.dueEdited ? 'Set by you; a severity change will not move it' : `From the severity: ${formatDate(effectiveDueAt(issue, ctx.now))}`}>
        <div className="flex items-center gap-2">
          <DatePicker
            aria-label={`${title} due date`}
            value={effectiveDueAt(issue, ctx.now).slice(0, 10)}
            onIsoChange={(iso) => {
              if (!iso) return onChange({ ...issue, dueAt: null, dueEdited: false });
              const at = new Date(`${iso}T00:00:00`);
              at.setHours(17, 0, 0, 0);
              onChange({ ...issue, dueAt: at.toISOString(), dueEdited: true });
            }}
          />
          {issue.dueEdited ? (
            <Button size="sm" variant="ghost" onClick={() => onChange({ ...issue, dueAt: null, dueEdited: false })}>
              Reset
            </Button>
          ) : null}
        </div>
      </FormField>
    </section>
  );
}

const SEVERITY_SHORT: Record<PtiDefectSeverity, string> = {
  monitor: 'Monitor',
  replace_soon: 'Replace soon',
  replace_now: 'Replace now',
  oos_risk: 'OOS risk',
};

const SEVERITY_ON: Record<PtiDefectSeverity, string> = {
  monitor: 'border-nw-neutral-border bg-nw-neutral-bg text-nw-neutral-text',
  replace_soon: 'border-nw-warning-border bg-nw-warning-bg text-nw-warning-text',
  replace_now: 'border-nw-warning-border bg-nw-warning-bg text-nw-warning-text',
  oos_risk: 'border-nw-urgent-border bg-nw-urgent-bg text-nw-urgent-text',
};

function holdWord(severity: PtiDefectSeverity): string {
  switch (severity) {
    case 'oos_risk':
      return 'blocks dispatch';
    case 'replace_now':
      return 'restricts the unit';
    default:
      return 'no hold';
  }
}

/** The Telegram link is the inspection's; the clip time and screenshots are this issue's. */
function Evidence({
  issue,
  source,
  onChange,
  uploadedBy,
}: {
  issue: IssueDraft;
  source: TelegramSource | null;
  onChange: (next: IssueDraft) => void;
  uploadedBy: string;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const required = screenshotRequired(issue.severity);

  return (
    <FormField
      label="Evidence"
      required={required}
      description={source ? `Video: ${source.chatTitle} (inherited)` : 'The Telegram link comes from the receipt'}
      error={error ?? undefined}
    >
      <div className="flex flex-col gap-2">
        <Input
          aria-label="Clip time"
          value={issue.clipTime}
          onChange={(event) => onChange({ ...issue, clipTime: event.target.value })}
          placeholder="Where in the video, e.g. 04:18"
          className="w-44"
        />
        <div className="flex flex-wrap items-center gap-1.5">
          {issue.screenshots.map((shot) => (
            <Badge key={shot.fileId} tone="neutral" variant="outline">
              {shot.fileName}
              <button
                type="button"
                aria-label={`Remove ${shot.fileName}`}
                className="ml-1 inline-flex text-muted hover:text-ink"
                onClick={() => onChange({ ...issue, screenshots: issue.screenshots.filter((s) => s.fileId !== shot.fileId) })}
              >
                <X className="size-3" />
              </button>
            </Badge>
          ))}
          <input
            ref={input}
            type="file"
            accept="image/*"
            multiple
            className="sr-only"
            aria-label="Screenshot files"
            onChange={async (event) => {
              const files = Array.from(event.target.files ?? []);
              event.target.value = '';
              if (files.length === 0) return;
              setBusy(true);
              setError(null);
              try {
                const added = [];
                for (const file of files) added.push(await uploadScreenshot(file, uploadedBy));
                onChange({ ...issue, screenshots: [...issue.screenshots, ...added] });
              } catch (err) {
                setError(err instanceof Error ? err.message : 'The screenshot could not be uploaded');
              } finally {
                setBusy(false);
              }
            }}
          />
          <Button size="sm" variant="secondary" icon={<ImagePlus />} loading={busy} onClick={() => input.current?.click()}>
            {issue.screenshots.length === 0 ? 'Add screenshot' : 'Add another'}
          </Button>
          {required && issue.screenshots.length === 0 ? (
            <span className="text-xs text-nw-warning-text">Needed at this severity</span>
          ) : null}
        </div>
      </div>
    </FormField>
  );
}

export type { PtiComponentDef };
