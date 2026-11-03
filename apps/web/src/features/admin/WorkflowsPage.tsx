import { useMemo, useState } from 'react';
import { Plus, Workflow as WorkflowIcon } from 'lucide-react';
import {
  CONDITION_OPERATOR_LABELS,
  type ConditionOperator,
  type WorkflowCondition,
  type WorkflowRule,
} from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  Card,
  FormField,
  Input,
  Modal,
  PageHeader,
  Select,
  Tabs,
  Textarea,
  useToast,
} from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';
import {
  Absent,
  AdminStatStrip,
  PermissionGate,
  RunStatusBadge,
  WorkflowStatusBadge,
} from './components/AdminKit';
import {
  adminApi,
  useAdminMutation,
  useHasPermission,
  usePermissionCheck,
  useRoles,
  useWorkflowCatalog,
  useWorkflowRuns,
  useWorkflowSummary,
  useWorkflows,
} from './useAdmin';

export function WorkflowsPage() {
  const check = usePermissionCheck('workflows.view');
  return (
    <PermissionGate check={check} permission="workflows.view" what="automation">
      <WorkflowsPageContent />
    </PermissionGate>
  );
}

/**
 * Automation.
 *
 * Rules fire off the audit trail, which is already the record of everything that happens in this
 * product. That is why the trigger list is short and specific: each entry is an event a service
 * actually writes, so a rule cannot be built on something that never happens.
 *
 * Runs are shown whether they acted or not. A rule that matched and skipped every action records
 * why — "no mail transport is configured" is on the run, not swallowed.
 */
function WorkflowsPageContent() {
  const canCreate = useHasPermission('workflows.create');
  const canEdit = useHasPermission('workflows.edit');

  const rules = useWorkflows();
  const summary = useWorkflowSummary();
  const catalog = useWorkflowCatalog();
  const runs = useWorkflowRuns();
  const [tab, setTab] = useState('rules');
  const [creating, setCreating] = useState(false);

  const unimplemented = (catalog.data?.actions ?? []).filter((action) => !action.implemented);

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Workflows"
        description="Rules that react to changes recorded in the audit trail."
        actions={
          canCreate ? (
            <Button onClick={() => setCreating(true)}>
              <Plus aria-hidden className="size-4" />
              New rule
            </Button>
          ) : null
        }
      />

      <AdminStatStrip
        loading={summary.isLoading}
        stats={[
          { key: 'rules', label: 'Rules', value: summary.data?.rules.total ?? null },
          {
            key: 'active',
            label: 'Active',
            value: summary.data?.rules.active ?? null,
            tone: 'success',
          },
          { key: 'runs', label: 'Runs', value: summary.data?.runs.total ?? null },
          {
            key: 'skipped',
            label: 'Skipped',
            value: summary.data?.runs.skipped ?? null,
            tone: 'warning',
          },
          {
            key: 'failed',
            label: 'Failed',
            value: summary.data?.runs.failed ?? null,
            tone: 'danger',
          },
        ]}
      />

      {unimplemented.length > 0 ? (
        <Alert tone="info" title="Not every action is built">
          <ul className="list-disc pl-4">
            {unimplemented.map((action) => (
              <li key={action.type}>
                <strong>{action.label}</strong> — {action.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <Tabs
        value={tab}
        onValueChange={setTab}
        items={[
          { value: 'rules', label: 'Rules' },
          { value: 'runs', label: 'Run history' },
        ]}
      />

      {tab === 'rules' ? (
        <div className="flex flex-col gap-3">
          {rules.data?.length === 0 ? (
            <Card className="p-6">
              <Absent>No rules yet. Nothing is automated.</Absent>
            </Card>
          ) : null}
          {(rules.data ?? []).map((rule) => (
            <RuleCard key={rule.id} rule={rule} canEdit={canEdit} />
          ))}
        </div>
      ) : (
        <Card className="flex flex-col divide-y divide-line">
          {runs.data?.length === 0 ? (
            <div className="p-6">
              <Absent>No rule has run yet.</Absent>
            </div>
          ) : null}
          {(runs.data ?? []).map((run) => (
            <article key={run.id} className="flex flex-col gap-1.5 p-3">
              <header className="flex flex-wrap items-center gap-2">
                <RunStatusBadge status={run.status} />
                <span className="text-sm font-medium text-ink">{run.ruleName ?? run.ruleId}</span>
                <span className="text-xs text-muted">{formatDateTime(run.startedAt)}</span>
                {run.durationMs !== null ? (
                  <span className="text-xs text-muted">{run.durationMs} ms</span>
                ) : null}
              </header>
              {run.triggerSummary ? (
                <p className="text-sm text-muted">{run.triggerSummary}</p>
              ) : null}
              {run.skipReason ? (
                <p className="text-xs text-warning-text">{run.skipReason}</p>
              ) : null}
              {run.error ? <p className="text-xs text-danger-text">{run.error}</p> : null}
              <ul className="flex flex-col gap-0.5">
                {run.steps.map((step, index) => (
                  <li key={`${step.action}-${index}`} className="text-xs text-muted">
                    <span className="font-medium text-ink">{step.action}</span> · {step.outcome} —{' '}
                    {step.detail}
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </Card>
      )}

      {creating ? <RuleModal onClose={() => setCreating(false)} /> : null}
    </div>
  );
}

function RuleCard({ rule, canEdit }: { rule: WorkflowRule; canEdit: boolean }) {
  const { toast } = useToast();
  const mutation = useAdminMutation((status: string) =>
    adminApi.updateWorkflow(rule.id, { status }),
  );
  const [error, setError] = useState<string | null>(null);

  const toggle = async () => {
    const next = rule.status === 'active' ? 'paused' : 'active';
    setError(null);
    try {
      await mutation.mutateAsync(next);
      toast({ title: `${rule.name} ${next}`, tone: 'success' });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not change the rule');
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 text-md font-bold text-ink">
            <WorkflowIcon aria-hidden className="size-4 text-muted" />
            {rule.name}
            <WorkflowStatusBadge status={rule.status} />
          </h3>
          <p className="mt-0.5 text-xs text-muted">{rule.description ?? 'No description.'}</p>
        </div>
        {canEdit ? (
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void toggle()}
            loading={mutation.isPending}
          >
            {rule.status === 'active' ? 'Pause' : 'Activate'}
          </Button>
        ) : null}
      </header>

      {error ? (
        <Alert tone="danger" title="Not changed">
          {error}
        </Alert>
      ) : null}

      <dl className="grid gap-2 text-xs sm:grid-cols-3">
        <div>
          <dt className="font-medium text-muted">When</dt>
          <dd className="text-ink">{rule.triggerLabel ?? rule.trigger}</dd>
        </div>
        <div>
          <dt className="font-medium text-muted">Conditions</dt>
          <dd className="text-ink">
            {rule.conditions.length === 0 ? (
              <Absent>Every event of this kind</Absent>
            ) : (
              rule.conditions
                .map((condition) =>
                  `${CONDITION_OPERATOR_LABELS[condition.operator]} ${condition.field} ${condition.value}`.trim(),
                )
                .join(' and ')
            )}
          </dd>
        </div>
        <div>
          <dt className="font-medium text-muted">Then</dt>
          <dd className="flex flex-wrap gap-1">
            {rule.actions.map((action, index) => (
              <Badge key={`${action.type}-${index}`} tone="neutral" variant="soft" size="sm">
                {action.type}
              </Badge>
            ))}
          </dd>
        </div>
      </dl>

      <footer className="flex gap-4 border-t border-line pt-2 text-xs text-muted">
        <span>
          Ran {rule.runCount} {rule.runCount === 1 ? 'time' : 'times'}
        </span>
        <span>
          Last run {rule.lastRunAt ? formatDateTime(rule.lastRunAt) : <Absent>never</Absent>}
        </span>
        <span>Created by {rule.ownerName ?? 'unknown'}</span>
      </footer>
    </Card>
  );
}

function RuleModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const catalog = useWorkflowCatalog();
  const roles = useRoles();
  const mutation = useAdminMutation(adminApi.createWorkflow);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [trigger, setTrigger] = useState('');
  const [conditions, setConditions] = useState<WorkflowCondition[]>([]);
  const [roleCode, setRoleCode] = useState('');
  const [title, setTitle] = useState('');
  const [severity, setSeverity] = useState('info');
  const [error, setError] = useState<string | null>(null);

  const selectedTrigger = useMemo(
    () => catalog.data?.triggers.find((candidate) => candidate.id === trigger) ?? null,
    [catalog.data, trigger],
  );

  const submit = async () => {
    setError(null);
    try {
      await mutation.mutateAsync({
        name,
        description: description || null,
        trigger,
        conditions,
        actions: [{ type: 'notify', roleCode, severity, title: title || name }],
        status: 'active',
      });
      toast({ title: `${name} created and active`, tone: 'success' });
      onClose();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not create the rule');
    }
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title="New automation rule"
      description="Reacts to a change recorded in the audit trail and notifies a role."
      size="md"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            loading={mutation.isPending}
            disabled={!name || !trigger || !roleCode}
          >
            Create rule
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not created">
            {error}
          </Alert>
        ) : null}

        <FormField label="Name" required>
          <Input value={name} onChange={(event) => setName(event.target.value)} />
        </FormField>
        <FormField label="Description">
          <Textarea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </FormField>

        <FormField label="When" required description="Only events this system actually records.">
          <Select
            options={(catalog.data?.triggers ?? []).map((candidate) => ({
              value: candidate.id,
              label: `${candidate.module} — ${candidate.label}`,
            }))}
            value={trigger}
            onValueChange={(value) => {
              setTrigger(value);
              setConditions([]);
            }}
          />
        </FormField>

        {selectedTrigger ? (
          <FormField
            label="Only when"
            description={
              selectedTrigger.fields.length === 0
                ? 'This event carries no fields to filter on, so the rule runs on every occurrence.'
                : 'Leave empty to run on every occurrence.'
            }
          >
            <div className="flex flex-col gap-2">
              {conditions.map((condition, index) => (
                <div key={index} className="flex gap-2">
                  <Select
                    options={Object.entries(CONDITION_OPERATOR_LABELS).map(([value, label]) => ({
                      value,
                      label,
                    }))}
                    value={condition.operator}
                    onValueChange={(value) =>
                      setConditions(
                        conditions.map((existing, i) =>
                          i === index
                            ? { ...existing, operator: value as ConditionOperator }
                            : existing,
                        ),
                      )
                    }
                  />
                  <Select
                    options={selectedTrigger.fields.map((field) => ({
                      value: field,
                      label: field,
                    }))}
                    value={condition.field}
                    onValueChange={(value) =>
                      setConditions(
                        conditions.map((existing, i) =>
                          i === index ? { ...existing, field: value } : existing,
                        ),
                      )
                    }
                  />
                  <Input
                    placeholder="value"
                    value={condition.value}
                    onChange={(event) =>
                      setConditions(
                        conditions.map((existing, i) =>
                          i === index ? { ...existing, value: event.target.value } : existing,
                        ),
                      )
                    }
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setConditions(conditions.filter((_, i) => i !== index))}
                  >
                    Remove
                  </Button>
                </div>
              ))}
              {selectedTrigger.fields.length > 0 ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() =>
                    setConditions([
                      ...conditions,
                      {
                        operator: 'field_changed_to',
                        field: selectedTrigger.fields[0] ?? '',
                        value: '',
                      },
                    ])
                  }
                >
                  Add condition
                </Button>
              ) : null}
            </div>
          </FormField>
        ) : null}

        <FormField label="Notify the role" required>
          <Select
            options={(roles.data ?? []).map((role) => ({ value: role.code, label: role.name }))}
            value={roleCode}
            onValueChange={setRoleCode}
          />
        </FormField>
        <FormField label="Notification title" description="Defaults to the rule name.">
          <Input value={title} onChange={(event) => setTitle(event.target.value)} />
        </FormField>
        <FormField label="Severity">
          <Select
            options={[
              { value: 'info', label: 'Info' },
              { value: 'warning', label: 'Warning' },
              { value: 'critical', label: 'Critical' },
            ]}
            value={severity}
            onValueChange={setSeverity}
          />
        </FormField>
      </div>
    </Modal>
  );
}
