import { ImagePlus, Trash2, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { PTI_DEFECT_SEVERITIES, screenshotRequired, type PtiDefectSeverity } from '@neway/shared';
import {
  Badge,
  Button,
  DatePicker,
  FormField,
  IconButton,
  Input,
  Select,
  Textarea,
  cn,
} from '@/design-system';
import { uploadScreenshot } from './api';
import {
  NEXT_ACTION_LABEL,
  effectiveDueAt,
  withSeverity,
  type IssueDraft,
  type NextAction,
  type ReviewContext,
} from './review-plan';

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

/**
 * One issue on the walk-around, as the owner drew it (2026-09-21): component, what's wrong,
 * severity in a 2×2, evidence beside its timestamp, responsible beside the follow-up date, and
 * the action taken. Nothing about the truck, the driver or the week is asked again.
 */
export function IssueForm({
  issue,
  index,
  ctx,
  onChange,
  onRemove,
  uploadedBy,
  disabled = false,
}: {
  issue: IssueDraft;
  index: number;
  ctx: ReviewContext;
  onChange: (next: IssueDraft) => void;
  onRemove: () => void;
  uploadedBy: string;
  disabled?: boolean;
}) {
  const title = `Issue ${index + 1}`;
  const component = ctx.components.find((c) => c.key === issue.component) ?? null;

  return (
    <section
      className="flex flex-col gap-3 rounded-[10px] border border-nw-border bg-nw-panel p-3"
      aria-label={title}
    >
      <header className="flex items-center gap-2">
        <h4 className="text-sm font-bold text-nw-text">{title}</h4>
        <Badge tone="info" variant="soft">
          New issue (not saved)
        </Badge>
        <IconButton
          label={`Remove ${title}`}
          size="sm"
          variant="ghost"
          className="ml-auto"
          disabled={disabled}
          onClick={onRemove}
        >
          <Trash2 />
        </IconButton>
      </header>

      <FormField label="Component" required>
        <Select
          aria-label={`${title} component`}
          value={issue.component ?? ''}
          disabled={disabled}
          onValueChange={(key) => onChange({ ...issue, component: key || null, quickPick: null })}
          placeholder="Choose the component"
          options={ctx.components.map((c) => ({ value: c.key ?? '', label: c.name }))}
        />
      </FormField>

      <FormField label="What’s wrong" required>
        <Textarea
          aria-label={`${title} description`}
          rows={2}
          disabled={disabled}
          value={issue.description}
          onChange={(event) => onChange({ ...issue, description: event.target.value })}
          placeholder="Describe the issue, e.g. Slack adjuster out of stroke on axle 3, driver side"
        />
      </FormField>

      <FormField label="Severity">
        <div role="group" aria-label={`${title} severity`} className="grid grid-cols-2 gap-2">
          {PTI_DEFECT_SEVERITIES.map((severity) => {
            const on = issue.severity === severity;
            return (
              <button
                key={severity}
                type="button"
                aria-pressed={on}
                disabled={disabled}
                className={cn(
                  'h-9 rounded-lg border text-[13px] font-semibold transition-colors',
                  on
                    ? SEVERITY_ON[severity]
                    : 'border-nw-border-strong bg-nw-panel text-nw-text-2 hover:bg-nw-hover',
                )}
                onClick={() => onChange(withSeverity(issue, severity, ctx))}
              >
                {SEVERITY_SHORT[severity]}
              </button>
            );
          })}
        </div>
      </FormField>

      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_200px]">
        <Evidence issue={issue} onChange={onChange} uploadedBy={uploadedBy} disabled={disabled} />
        <FormField label="Timestamp (optional)">
          <Input
            aria-label={`${title} clip time`}
            disabled={disabled}
            value={issue.clipTime}
            onChange={(event) => onChange({ ...issue, clipTime: event.target.value })}
            placeholder="Where in the video, e.g. 04:18"
          />
        </FormField>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Responsible">
          <Select
            aria-label={`${title} owner`}
            value={issue.ownerId ?? ''}
            disabled={disabled}
            onValueChange={(id) => {
              const owner = ctx.assignees.find((a) => a.id === id) ?? null;
              onChange({
                ...issue,
                ownerId: owner?.id ?? null,
                ownerName: owner?.name ?? null,
                ownerEdited: true,
              });
            }}
            placeholder="Unassigned"
            options={ctx.assignees.map((a) => ({ value: a.id, label: a.name }))}
          />
        </FormField>
        <FormField label="Follow-up date">
          <DatePicker
            aria-label={`${title} due date`}
            disabled={disabled}
            value={effectiveDueAt(issue, ctx.now).slice(0, 10)}
            onIsoChange={(iso) => {
              if (!iso) return onChange({ ...issue, dueAt: null, dueEdited: false });
              const at = new Date(`${iso}T00:00:00`);
              at.setHours(17, 0, 0, 0);
              onChange({ ...issue, dueAt: at.toISOString(), dueEdited: true });
            }}
          />
        </FormField>
      </div>

      <FormField label="Action taken (optional)">
        <div className="flex flex-col gap-2">
          <Select
            aria-label={`${title} next action`}
            value={issue.nextAction}
            disabled={disabled}
            onValueChange={(value) => onChange({ ...issue, nextAction: value as NextAction })}
            options={(Object.keys(NEXT_ACTION_LABEL) as NextAction[]).map((value) => ({
              value,
              label: NEXT_ACTION_LABEL[value],
            }))}
          />
          {issue.nextAction === 'work_order' ? (
            <Input
              aria-label={`${title} vendor`}
              disabled={disabled}
              value={issue.vendorName}
              onChange={(event) => onChange({ ...issue, vendorName: event.target.value })}
              placeholder={`Vendor or shop for the ${component?.name ?? 'repair'} (optional)`}
            />
          ) : null}
        </div>
      </FormField>
    </section>
  );
}

/** A photo or screenshot from the video; required at the severities that hold the unit. */
function Evidence({
  issue,
  onChange,
  uploadedBy,
  disabled,
}: {
  issue: IssueDraft;
  onChange: (next: IssueDraft) => void;
  uploadedBy: string;
  disabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const required = screenshotRequired(issue.severity);

  return (
    <FormField
      label={required ? 'Evidence' : 'Evidence (optional)'}
      required={required}
      error={error ?? undefined}
      description={
        required && issue.screenshots.length === 0 ? 'Needed at this severity' : undefined
      }
    >
      <div className="flex flex-col gap-1.5">
        <button
          type="button"
          disabled={disabled || busy}
          onClick={() => input.current?.click()}
          className="flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg border border-dashed border-nw-border-strong bg-nw-subtle px-3 py-2 text-[13px] font-semibold text-nw-text hover:bg-nw-hover disabled:opacity-60"
        >
          <span className="inline-flex items-center gap-1.5">
            <ImagePlus className="size-4 text-nw-text-3" aria-hidden />
            {busy ? 'Uploading…' : 'Add photo or screenshot'}
          </span>
          <span className="text-[11.5px] font-normal text-nw-text-3">PNG, JPG up to 10 MB</span>
        </button>
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
        {issue.screenshots.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            {issue.screenshots.map((shot) => (
              <Badge key={shot.fileId} tone="neutral" variant="outline">
                {shot.fileName}
                <button
                  type="button"
                  aria-label={`Remove ${shot.fileName}`}
                  className="ml-1 inline-flex text-muted hover:text-ink"
                  onClick={() =>
                    onChange({
                      ...issue,
                      screenshots: issue.screenshots.filter((s) => s.fileId !== shot.fileId),
                    })
                  }
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))}
            <Button size="sm" variant="ghost" onClick={() => input.current?.click()}>
              Add another
            </Button>
          </div>
        ) : null}
      </div>
    </FormField>
  );
}
