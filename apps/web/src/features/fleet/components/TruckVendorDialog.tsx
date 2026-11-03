import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import type { DriverPayPlan } from '@neway/shared';
import {
  ConfirmDialog,
  DatePicker,
  FormField,
  Input,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import {
  changeTruckVendorPercent,
  renameTruckVendor,
  endTruckVendor,
  fetchDriverAccount,
  fetchTruckVendors,
  moveTruckToVendor,
  updateDriverProfile,
} from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { useInvalidateFleet } from '../useFleet';

/**
 * Move to vendor / Move back to the company (owner, 2026-10-28).
 *
 * A vendor puts their own truck in our fleet. The dialog asks the two things that matter to the
 * company: what the company keeps of the truck's gross, and what the driver gets - the vendor's own
 * share is theirs. Driver pay is Accounting's: it is shown, and saved to the driver's pay profile
 * from the same day, only for somebody who may change it.
 */

const NEW_VENDOR = '__new__';
const PLAN_OPTIONS = [
  { value: 'percent_of_gross', label: '% of gross' },
  { value: 'per_mile', label: 'Per mile' },
  { value: 'flat_per_load', label: 'Per load' },
];

function planText(plan: DriverPayPlan | null | undefined): string {
  if (!plan || plan.kind === 'none') return 'Not set';
  if (plan.kind === 'per_mile') return `$${plan.rate.toFixed(2)} per mile`;
  if (plan.kind === 'flat_per_load') return `$${plan.rate.toFixed(2)} per load`;
  return `${plan.rate}% of ${plan.kind === 'percent_of_linehaul' ? 'linehaul' : 'gross'}`;
}

export function MoveToVendorDialog({
  open,
  truckId,
  unitNumber,
  updatedAt,
  driverId,
  driverName,
  onClose,
}: {
  open: boolean;
  truckId: string;
  unitNumber: string;
  updatedAt: string | undefined;
  driverId: string | null;
  driverName: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const account = useAccount();
  const can = (code: string) => account !== null && (account.isOwner || account.permissions.includes(code));
  const seesPay = can('accounting.view');
  const editsPay = can('accounting.edit');

  const vendors = useQuery({ queryKey: ['truck-vendors'], queryFn: fetchTruckVendors, enabled: open });
  const driverAccount = useQuery({
    queryKey: ['accounting', 'driver-account', driverId],
    queryFn: () => fetchDriverAccount(driverId as string),
    enabled: open && Boolean(driverId) && seesPay,
    retry: false,
  });
  const current = driverAccount.data?.profile.current ?? null;

  const [vendorId, setVendorId] = useState('');
  const [vendorName, setVendorName] = useState('');
  const [percent, setPercent] = useState('');
  const [from, setFrom] = useState(companyToday());
  const [planKind, setPlanKind] = useState<string>('percent_of_gross');
  const [planRate, setPlanRate] = useState('');
  const [note, setNote] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  // The driver's pay as Accounting has it, ready to keep or change.
  useEffect(() => {
    if (!current) return;
    const plan = current.loadedPlan;
    if (plan.kind === 'per_mile' || plan.kind === 'flat_per_load' || plan.kind === 'percent_of_gross') setPlanKind(plan.kind);
    setPlanRate(plan.kind === 'none' ? '' : String(plan.rate));
  }, [current]);

  const close = () => {
    setVendorId('');
    setVendorName('');
    setPercent('');
    setNote('');
    setErrors({});
    setFrom(companyToday());
    onClose();
  };

  const vendorOptions = [
    ...(vendors.data ?? []).map((v) => ({ value: v.id, label: v.name })),
    { value: NEW_VENDOR, label: '+ New vendor' },
  ];
  const isNew = vendorId === NEW_VENDOR || (vendors.data?.length === 0 && vendorId === '');

  const confirm = async () => {
    const next: Record<string, string> = {};
    const pct = Number(percent);
    if (!vendorId && !vendorName.trim()) next.vendor = 'Choose the vendor or add a new one';
    if (isNew && vendorName.trim().length < 2) next.vendor = 'Type the vendor’s name';
    if (percent.trim() === '' || !Number.isFinite(pct) || pct < 0 || pct > 100) next.percent = 'A percentage from 0 to 100';
    if (!from) next.from = 'Pick the first day';
    const rate = Number(planRate);
    const payChanged =
      editsPay && driverId && current && planRate.trim() !== '' && (current.loadedPlan.kind !== planKind || current.loadedPlan.rate !== rate);
    if (payChanged && (!Number.isFinite(rate) || rate < 0)) next.pay = 'A driver pay figure of 0 or more';
    if (Object.keys(next).length > 0) {
      setErrors(next);
      throw new Error('invalid');
    }
    try {
      await moveTruckToVendor(truckId, {
        ...(isNew ? { vendorName: vendorName.trim() } : { vendorId }),
        companyPercent: pct,
        effectiveFrom: from,
        ...(note.trim() ? { note: note.trim() } : {}),
        ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}),
      });
      if (payChanged && driverId && current && driverAccount.data) {
        const { byId: _byId, byName: _byName, at: _at, ...rest } = current;
        await updateDriverProfile(driverId, {
          ...rest,
          effectiveFrom: from,
          loadedPlan: { kind: planKind as DriverPayPlan['kind'], rate },
          reason: `Unit ${unitNumber} moved to a vendor`,
          expectedVersion: driverAccount.data.profile.version,
        });
      }
      await invalidate();
      toast({ tone: 'success', title: `Unit ${unitNumber} runs for the vendor from ${from}`, description: `The company keeps ${pct}% of its gross; its costs are the vendor’s.` });
      close();
    } catch (cause) {
      setErrors({ form: cause instanceof Error ? cause.message : 'The change was refused.' });
      throw cause;
    }
  };

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={`Move unit ${unitNumber} to a vendor`}
      description="The truck belongs to the vendor. The company keeps its percentage of the truck’s gross; the driver is paid out of the vendor’s part; repairs, fuel and other costs on the truck are the vendor’s, not the company’s."
      confirmLabel="Move to vendor"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        <FormField label="Vendor" required error={errors.vendor}>
          <Select
            aria-label="Vendor"
            options={vendorOptions}
            value={vendorId || (isNew ? NEW_VENDOR : '')}
            placeholder={vendors.isPending ? 'Loading…' : 'Choose the vendor'}
            onValueChange={(v) => {
              setVendorId(v);
              setErrors((e) => ({ ...e, vendor: '' }));
            }}
          />
        </FormField>
        {isNew ? (
          <FormField label="New vendor’s name" required>
            <Input value={vendorName} onChange={(e) => setVendorName(e.target.value)} placeholder="The person whose truck it is" />
          </FormField>
        ) : null}
        <FormField label="Company keeps" required error={errors.percent} description="Percent of the truck’s gross that stays with the company.">
          <Input inputMode="decimal" suffix="%" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="20" />
        </FormField>
        <FormField
          label={`Driver gets${driverName ? ` (${driverName})` : ''}`}
          error={errors.pay}
          description={
            !driverId
              ? 'No driver on the unit. Accounting sets the driver’s pay when one is assigned.'
              : editsPay
                ? 'Paid out of the vendor’s part. Saved to the driver’s pay from the same day.'
                : 'Set by Accounting in the driver’s account.'
          }
        >
          {!driverId ? (
            <span className="text-sm text-muted">No driver</span>
          ) : !seesPay ? (
            <span className="text-sm text-muted">Accounting sets it</span>
          ) : driverAccount.isPending ? (
            <span className="text-sm text-muted">Loading…</span>
          ) : editsPay ? (
            <div className="flex gap-2">
              <div className="w-40">
                <Select aria-label="Driver pay basis" options={PLAN_OPTIONS} value={planKind} onValueChange={setPlanKind} />
              </div>
              <Input
                aria-label="Driver pay rate"
                inputMode="decimal"
                value={planRate}
                onChange={(e) => setPlanRate(e.target.value)}
                {...(planKind === 'percent_of_gross' ? { suffix: '%' } : { prefix: '$', money: false })}
              />
            </div>
          ) : (
            <span className="text-sm text-ink">{planText(current?.loadedPlan)}</span>
          )}
        </FormField>
        <FormField label="From" required error={errors.from}>
          <DatePicker aria-label="From" value={from} onIsoChange={(iso) => setFrom(iso ?? '')} />
        </FormField>
        <FormField label="Note (optional)" error={errors.form}>
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Anything Accounting should know" />
        </FormField>
      </div>
    </ConfirmDialog>
  );
}

/**
 * Edit percentage (owner, 2026-10-28): 10% to 15%, from a day on. Loads delivered before that day
 * keep the old split; the change is audited.
 */
export function EditVendorPercentDialog({
  open,
  truckId,
  unitNumber,
  vendorName,
  currentPercent,
  updatedAt,
  onClose,
}: {
  open: boolean;
  truckId: string;
  unitNumber: string;
  vendorName: string;
  currentPercent: number;
  updatedAt: string | undefined;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const [percent, setPercent] = useState('');
  const [from, setFrom] = useState(companyToday());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) setPercent(String(currentPercent));
  }, [open, currentPercent]);
  const close = () => {
    setReason('');
    setError(null);
    setFrom(companyToday());
    onClose();
  };
  const confirm = async () => {
    const pct = Number(percent);
    if (percent.trim() === '' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      setError('A percentage from 0 to 100');
      throw new Error('invalid');
    }
    try {
      await changeTruckVendorPercent(truckId, {
        companyPercent: pct,
        effectiveFrom: from,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
        ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}),
      });
      await invalidate();
      toast({ tone: 'success', title: `Unit ${unitNumber}: the company keeps ${pct}% from ${from}` });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change was refused.');
      throw cause;
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={`Edit percentage · unit ${unitNumber}`}
      description={`${vendorName}'s truck. The company keeps ${currentPercent}% of its gross now. Loads delivered before the day below keep the old percentage.`}
      confirmLabel="Save percentage"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        <FormField label="Company keeps" required error={error ?? undefined}>
          <Input aria-label="Company keeps" inputMode="decimal" suffix="%" value={percent} onChange={(e) => setPercent(e.target.value)} />
        </FormField>
        <FormField label="From" required description="The first delivery day the new percentage counts for.">
          <DatePicker aria-label="From" value={from} onIsoChange={(iso) => setFrom(iso ?? '')} />
        </FormField>
        <FormField label="Reason (optional)">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it changes" />
        </FormField>
      </div>
    </ConfirmDialog>
  );
}

export function EndVendorDialog({
  open,
  truckId,
  unitNumber,
  vendorName,
  updatedAt,
  onClose,
}: {
  open: boolean;
  truckId: string;
  unitNumber: string;
  vendorName: string;
  updatedAt: string | undefined;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const [to, setTo] = useState(companyToday());
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setReason('');
    setError(null);
    onClose();
  };
  const confirm = async () => {
    if (reason.trim().length < 3) {
      setError('Say why');
      throw new Error('reason');
    }
    try {
      await endTruckVendor(truckId, { effectiveTo: to, reason: reason.trim(), ...(updatedAt ? { expectedUpdatedAt: updatedAt } : {}) });
      await invalidate();
      toast({ tone: 'success', title: `Unit ${unitNumber} is a company truck after ${to}` });
      close();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change was refused.');
      throw cause;
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) close();
      }}
      title={`Move unit ${unitNumber} back to the company?`}
      description={`It stops running for ${vendorName} after the day below. Loads and costs up to then stay the vendor’s; after it they are the company’s.`}
      confirmLabel="Move back to company"
      onConfirm={confirm}
    >
      <div className="flex flex-col gap-3">
        <FormField label="Last vendor day" required>
          <DatePicker aria-label="Last vendor day" value={to} onIsoChange={(iso) => setTo(iso ?? '')} />
        </FormField>
        <FormField label="Reason" required error={error ?? undefined}>
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is coming back" />
        </FormField>
      </div>
    </ConfirmDialog>
  );
}

/** Edit vendor name (owner, 2026-10-30): the truck owner's name, typed wrong, corrected everywhere it shows. */
export function RenameVendorDialog({ open, vendorId, vendorName, onClose }: { open: boolean; vendorId: string; vendorName: string; onClose: () => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const [name, setName] = useState(vendorName);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setName(vendorName);
      setError(null);
    }
  }, [open, vendorName]);
  const confirm = async () => {
    if (name.trim().length < 2) {
      setError('Type the vendor’s name');
      throw new Error('invalid');
    }
    try {
      const saved = await renameTruckVendor(vendorId, { name: name.trim(), expectedName: vendorName });
      await invalidate();
      toast({ tone: 'success', title: `Vendor renamed to ${saved.name}`, description: 'Every truck of this vendor shows the new name.' });
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The change was refused.');
      throw cause;
    }
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title="Edit vendor name"
      description={`Now: ${vendorName}. Every truck, arrangement and statement of this vendor shows the new name; the change is recorded with your name.`}
      confirmLabel="Save name"
      onConfirm={confirm}
    >
      <FormField label="Vendor name" required error={error ?? undefined}>
        <Input aria-label="Vendor name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
      </FormField>
    </ConfirmDialog>
  );
}
