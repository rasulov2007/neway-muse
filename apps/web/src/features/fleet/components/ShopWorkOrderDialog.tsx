import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Gauge, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  ASSET_TYPES,
  ASSET_TYPE_LABEL,
  SHOP_STAGES,
  SHOP_STAGE_LABEL,
  WORK_TYPES,
  WORK_TYPE_LABEL,
  WORK_ORDER_STATUSES,
  WORK_ORDER_STATUS_LABEL,
  workOrderLabel,
  type AssetType,
  type ShopStage,
  type WorkOrder,
  type WorkOrderStatus,
  type WorkType,
} from '@neway/shared';
import {
  Button,
  Combobox,
  DatePicker,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import { apiGet, apiPost } from '@/lib/api-client';
import { isEnabled } from '@/lib/feature-flags';
import { formatNumber } from '@/lib/format';

interface UnitOption {
  id: string;
  unitNumber: string;
  description: string;
  odometer: number | null;
}

/**
 * Opening a work order, from the shop floor.
 *
 * Four changes from the form it replaces, all of them the same idea: ask for what decides
 * something and nothing else.
 *
 * The title is gone. It was required, so people typed whatever made the form submit, and the label
 * a page shows is now built from the unit and the work type. Status is two options rather than six,
 * because the other four were describing how far along the shop was, which is a stage and belongs
 * on the record's history. The asset type comes first and filters the unit list, so a trailer
 * repair can never be filed against a truck. And nothing here mentions money: this dialog is used
 * by accounts that are not allowed to see a price, so it does not have a field for one.
 *
 * Fleet specification §3; the brief's create-modal section.
 */
export function ShopWorkOrderDialog({
  open,
  onOpenChange,
  defaultUnit,
  defaultWorkType,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pre-filled when the dialog is opened from a row that already names the unit. */
  defaultUnit?: { assetType: AssetType; unitId: string } | null;
  defaultWorkType?: WorkType;
  onDone?: (order: WorkOrder) => void;
}) {
  // Behind the same flag as the pages that open it. Only they open it today, so this is belt and
  // braces — and belt and braces is the right amount for the one form in Fleet that writes to a
  // table the older screens do not read.
  if (!isEnabled('fleet_v2')) return null;
  // The form is mounted fresh for each opening, keyed on what it was opened with. Reopening the
  // dialog from a different row must not show the previous row's answers, and a key says that
  // once — where the alternative is an effect that writes state after every render and has to be
  // told which prop changes matter.
  if (!open) return null;
  const seed = `${defaultUnit?.assetType ?? ''}:${defaultUnit?.unitId ?? ''}:${defaultWorkType ?? ''}`;
  return (
    <ShopWorkOrderForm
      key={seed}
      onOpenChange={onOpenChange}
      defaultUnit={defaultUnit}
      defaultWorkType={defaultWorkType}
      onDone={onDone}
    />
  );
}

function ShopWorkOrderForm({
  onOpenChange,
  defaultUnit,
  defaultWorkType,
  onDone,
}: {
  onOpenChange: (open: boolean) => void;
  defaultUnit?: { assetType: AssetType; unitId: string } | null;
  defaultWorkType?: WorkType;
  onDone?: (order: WorkOrder) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [assetType, setAssetType] = useState<AssetType>(defaultUnit?.assetType ?? 'truck');
  const [unitId, setUnitId] = useState<string | null>(defaultUnit?.unitId ?? null);
  const [status, setStatus] = useState<WorkOrderStatus>('in_shop');
  const [workType, setWorkType] = useState<WorkType>(defaultWorkType ?? 'oil_change');
  const [shopStage, setShopStage] = useState<ShopStage>('diagnosing');
  const [workDone, setWorkDone] = useState('');
  const [shopInAt, setShopInAt] = useState<Date | null>(new Date());
  const [odometer, setOdometer] = useState('');
  const [assignedTo, setAssignedTo] = useState('');
  const [error, setError] = useState<string | null>(null);

  const units = useQuery({
    queryKey: ['fleet', 'shop-units', assetType],
    queryFn: () => apiGet<{ data: UnitOption[] }>(`/fleet/units`, { assetType }),
    // The roster is stable within a shift; a mechanic opening this ten times should not refetch it.
    staleTime: 5 * 60_000,
  });

  const options = useMemo(
    () =>
      (units.data?.data ?? []).map((unit) => ({
        value: unit.id,
        label: unit.unitNumber,
        description: unit.description,
      })),
    [units.data],
  );
  const unit = (units.data?.data ?? []).find((row) => row.id === unitId) ?? null;

  // Prefilled from the unit, and editable: the reading on the dash is the one that counts.
  const odometerValue = odometer !== '' ? odometer : (unit?.odometer?.toString() ?? '');

  const create = useMutation({
    mutationFn: () =>
      apiPost<WorkOrder>('/fleet/work-orders', {
        assetType,
        unitId,
        status,
        workType,
        shopStage: status === 'in_shop' ? shopStage : undefined,
        workDone: workDone.trim() || undefined,
        shopInAt: shopInAt ? shopInAt.toISOString() : undefined,
        odometer:
          assetType === 'trailer' || odometerValue === '' ? undefined : Number(odometerValue),
        assignedTo: assignedTo.trim() || undefined,
      }),
    onSuccess: async (order) => {
      await queryClient.invalidateQueries({ queryKey: ['fleet'] });
      toast({
        tone: 'success',
        title: `${order.number} opened`,
        description: workOrderLabel(order.unitNumber, order.workType),
      });
      onOpenChange(false);
      onDone?.(order);
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'That work order could not be opened'),
  });

  // What was done is optional while the unit is in the shop, and required to close it. That is the
  // only rule in this form, and it is here because a completed record nobody can be asked about
  // cannot be audited later.
  const needsWorkDone = status === 'completed' && workDone.trim() === '';
  const valid = unitId !== null && !needsWorkDone;

  return (
    <Modal
      open
      onOpenChange={onOpenChange}
      size="md"
      title="Open a work order"
      description="Pick the unit and what is being done. Costs are not part of this form."
      footer={
        <>
          {needsWorkDone ? (
            <span className="mr-auto text-xs text-danger-text">
              Say what was done before completing it.
            </span>
          ) : null}
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            icon={status === 'completed' ? <Check /> : <Plus />}
            loading={create.isPending}
            disabled={!valid}
            onClick={() => {
              setError(null);
              create.mutate();
            }}
          >
            {status === 'completed' ? 'Save as completed' : 'Open work order'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}

        {/* Asset type, unit, status — in that order, because each one narrows the next. */}
        <div className="grid gap-4 sm:grid-cols-3">
          <FormField label="Asset type" required>
            <Select
              aria-label="Asset type"
              value={assetType}
              onValueChange={(value) => {
                setAssetType(value as AssetType);
                setUnitId(null);
              }}
              options={ASSET_TYPES.map((value) => ({ value, label: ASSET_TYPE_LABEL[value] }))}
            />
          </FormField>
          <FormField label="Unit" required>
            <Combobox
              aria-label="Unit"
              options={options}
              value={unitId}
              onValueChange={setUnitId}
              placeholder={assetType === 'truck' ? 'Search trucks…' : 'Search trailers…'}
              loading={units.isPending}
              emptyMessage="No unit matches"
            />
          </FormField>
          <FormField label="Status" required>
            <Select
              aria-label="Status"
              value={status}
              onValueChange={(value) => setStatus(value as WorkOrderStatus)}
              options={WORK_ORDER_STATUSES.map((value) => ({
                value,
                label: WORK_ORDER_STATUS_LABEL[value],
              }))}
            />
          </FormField>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Work type" required>
            <Select
              aria-label="Work type"
              value={workType}
              onValueChange={(value) => setWorkType(value as WorkType)}
              options={WORK_TYPES.map((value) => ({ value, label: WORK_TYPE_LABEL[value] }))}
            />
          </FormField>
          {status === 'in_shop' ? (
            <FormField label="Shop stage" description="Where it is now. It can change later.">
              <Select
                aria-label="Shop stage"
                value={shopStage}
                onValueChange={(value) => setShopStage(value as ShopStage)}
                options={SHOP_STAGES.map((value) => ({ value, label: SHOP_STAGE_LABEL[value] }))}
              />
            </FormField>
          ) : (
            <FormField label="Assigned to" description="Optional.">
              <Input
                value={assignedTo}
                onChange={(event) => setAssignedTo(event.target.value)}
                placeholder="Mechanic"
              />
            </FormField>
          )}
        </div>

        <FormField
          label="What was done"
          required={status === 'completed'}
          description={
            status === 'completed'
              ? 'Required to complete it.'
              : 'Optional now. Required when it is completed.'
          }
          error={needsWorkDone ? 'Say what was done' : undefined}
        >
          <Textarea
            rows={3}
            value={workDone}
            onChange={(event) => setWorkDone(event.target.value)}
            placeholder="Oil, filters, grease. Air leak at the gladhand rerouted and clamped."
          />
        </FormField>

        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Shop in" description="Defaults to now. Downtime counts from here.">
            <DatePicker value={shopInAt} onChange={(date) => setShopInAt(date ?? null)} />
          </FormField>
          {assetType === 'truck' ? (
            <FormField
              label="Odometer"
              description={
                unit?.odometer ? `Last recorded ${formatNumber(unit.odometer)} mi` : 'Optional.'
              }
            >
              <Input
                inputMode="numeric"
                prefix={<Gauge />}
                value={odometerValue}
                onChange={(event) => setOdometer(event.target.value)}
                placeholder="0"
              />
            </FormField>
          ) : (
            <FormField label="Odometer" description="A trailer has none.">
              <Input disabled value="" placeholder="—" />
            </FormField>
          )}
        </div>
      </div>
    </Modal>
  );
}
