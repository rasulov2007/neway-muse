import { useState } from 'react';
import { Settings2 } from 'lucide-react';
import { SETTING_GROUPS, type SettingGroup } from '@neway/shared';
import {
  Alert,
  Button,
  Card,
  FormField,
  Input,
  PageHeader,
  Select,
  Switch,
  useToast,
} from '@/design-system';
import { PtiComponentCatalogCard } from '@/features/fleet/components/PtiConditionPanels';
import { WorkOrderTypeCatalogCard } from '@/features/fleet/components/WorkOrderTypeCatalogCard';
import { UnitDocumentRulesCard } from '@/features/fleet/components/UnitDocumentRulesCard';
import { TruckTypesCard } from '@/features/fleet/pm/TruckTypesCard';
import { isEnabled } from '@/lib/feature-flags';
import { ApiError } from '@/lib/api-client';
import { Absent, PermissionGate } from './components/AdminKit';
import {
  adminApi,
  useAdminMutation,
  useHasPermission,
  usePermissionCheck,
  useSettings,
  type ResolvedSetting,
} from './useAdmin';

const GROUP_LABELS: Record<SettingGroup, string> = {
  company: 'Company',
  localization: 'Calendar & timezone',
  automation: 'Automation',
  hiring: 'Driver prequalification',
  hiring_costs: 'Cost per hire — unit costs',
  people: 'People — new accounts',
  routing: 'Route options — fuel',
  retention: 'Retention',
};

export function SettingsPage() {
  const check = usePermissionCheck('settings.view');
  return (
    <PermissionGate check={check} permission="settings.view" what="settings">
      <SettingsPageContent />
    </PermissionGate>
  );
}

/**
 * Company settings.
 *
 * Each field says who reads it. The timezone and week start are not preferences — they set the
 * boundaries of every reporting period in the dashboard, Reports and Analytics, so changing one
 * moves every number on those screens and the help text says so before you do it.
 *
 * A setting nothing reads yet is labelled as such rather than left looking live. That is one field
 * today; leaving it unlabelled would quietly devalue the other five.
 */
function SettingsPageContent() {
  const canEdit = useHasPermission('settings.edit');
  const settings = useSettings();

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <SettingsForm
        // Keyed by the moment the server last answered: a successful save discards the draft because
        // the form is rebuilt from the saved values, rather than an effect racing to clear it.
        key={settings.dataUpdatedAt}
        resolved={settings.data?.settings ?? []}
        notEnforced={settings.data?.notEnforced ?? []}
        canEdit={canEdit}
      />
      {/* Kept in the workspace beside the ratings it describes, not in the settings table. */}
      <PtiComponentCatalogCard canEdit={canEdit} />
      <WorkOrderTypeCatalogCard canEdit={canEdit} />
      <UnitDocumentRulesCard canEdit={canEdit} />
      {/* Oil-change intervals by truck type (owner's ask, 2026-09-22); the PM engine's group plans. */}
      {isEnabled('pm_module') ? <TruckTypesCard canEdit={canEdit} /> : null}
    </div>
  );
}

function SettingsForm({
  resolved,
  notEnforced,
  canEdit,
}: {
  resolved: ResolvedSetting[];
  notEnforced: { key: string; label: string; reason: string }[];
  canEdit: boolean;
}) {
  const { toast } = useToast();
  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [error, setError] = useState<string | null>(null);
  const mutation = useAdminMutation(adminApi.updateSettings);

  const dirty = Object.keys(draft).length > 0;

  const save = async () => {
    setError(null);
    try {
      await mutation.mutateAsync(draft);
      toast({ title: 'Settings saved', tone: 'success' });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the settings');
    }
  };

  const valueOf = (setting: ResolvedSetting) =>
    setting.key in draft ? draft[setting.key] : setting.value;

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Settings"
        description="Company configuration. Each field names the code that reads it."
        actions={
          canEdit ? (
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setDraft({})} disabled={!dirty}>
                Discard
              </Button>
              <Button onClick={() => void save()} disabled={!dirty} loading={mutation.isPending}>
                Save changes
              </Button>
            </div>
          ) : null
        }
      />

      {error ? (
        <Alert tone="danger" title="Not saved">
          {error}
        </Alert>
      ) : null}

      {notEnforced.length ? (
        <Alert tone="info" title="Stored, but not acted on yet">
          <ul className="list-disc pl-4">
            {notEnforced.map((entry) => (
              <li key={entry.key}>
                <strong>{entry.label}</strong> — {entry.reason}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {SETTING_GROUPS.map((group) => {
        const fields = resolved.filter((setting) => setting.group === group);
        if (fields.length === 0) return null;
        return (
          <Card key={group} className="flex flex-col gap-4 p-4">
            <h2 className="text-md font-bold text-ink">{GROUP_LABELS[group]}</h2>
            {fields.map((setting) => (
              <FormField
                key={setting.key}
                label={setting.label}
                description={
                  <span className="flex flex-col gap-0.5">
                    <span>{setting.help}</span>
                    {/* Provenance: which code reads this value. A gear at 11.5px tertiary — the
                        line is a fact about the setting, not part of its label. */}
                    <span className="flex items-center gap-1 text-2xs text-faint">
                      <Settings2 aria-hidden className="size-3 shrink-0" />
                      {setting.enforcedBy ? (
                        <>Read by: {setting.enforcedBy}</>
                      ) : (
                        <span className="text-warning-text">
                          Nothing reads this yet — {setting.notEnforcedReason}
                        </span>
                      )}
                    </span>
                  </span>
                }
              >
                <SettingControl
                  setting={setting}
                  value={valueOf(setting)}
                  disabled={!canEdit}
                  onChange={(value) => setDraft({ ...draft, [setting.key]: value })}
                />
              </FormField>
            ))}
          </Card>
        );
      })}

      {resolved.length === 0 ? (
        <Card className="p-6">
          <Absent>No settings are defined.</Absent>
        </Card>
      ) : null}
    </div>
  );
}

function SettingControl({
  setting,
  value,
  disabled,
  onChange,
}: {
  setting: ResolvedSetting;
  value: unknown;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  if (setting.kind === 'boolean') {
    return (
      <Switch
        checked={value === true}
        disabled={disabled}
        onCheckedChange={(checked) => onChange(checked)}
      />
    );
  }
  if (setting.kind === 'select') {
    return (
      <Select
        options={setting.options ?? []}
        value={typeof value === 'string' ? value : ''}
        disabled={disabled}
        onValueChange={onChange}
      />
    );
  }
  if (setting.kind === 'number') {
    return (
      <Input
        type="number"
        step="any"
        value={typeof value === 'number' ? String(value) : ''}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    );
  }
  return (
    <Input
      value={typeof value === 'string' ? value : ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
