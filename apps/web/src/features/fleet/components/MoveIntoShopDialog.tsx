import { useMutation, useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { WORK_TYPES, WORK_TYPE_LABEL, type CheckInWorkOrderInput, type WorkOrderDetail, type WorkType } from '@neway/shared';
import { Button, Combobox, DatePicker, FormField, Input, Modal, Select, Textarea } from '@/design-system';
import { listFleetVendors } from '@/demo';
import { apiPost } from '@/lib/api-client';
import { nowMs } from '@/lib/clock';

/**
 * In shop (owner, 2026-10-30): a scheduled work order taken into the shop. The Create work order
 * form, filled from what was booked - type, title, shop, technician, invoice number - for the
 * person to correct or add to; saving moves this same order to In the shop, so nobody creates a
 * second one. The invoice comes later, from the order's page, by the Fleet team.
 */
export function MoveIntoShopDialog({
  order,
  onClose,
  onSaved,
}: {
  order: WorkOrderDetail;
  onClose: () => void;
  onSaved: (next: WorkOrderDetail) => void;
}) {
  const [type, setType] = useState<WorkType>(order.workType);
  const [title, setTitle] = useState(order.title ?? '');
  const [date, setDate] = useState<Date | null>(new Date(nowMs()));
  const vendors = useQuery({ queryKey: ['vendors', 'options'], queryFn: () => listFleetVendors() });
  const vendorOptions = useMemo(
    () =>
      (vendors.data ?? []).map((v) => ({
        value: v.id,
        label: v.name,
        description: [v.city && v.state ? `${v.city}, ${v.state}` : v.city, v.kind.replace(/_/g, ' ')].filter(Boolean).join(' · '),
      })),
    [vendors.data],
  );
  const [pickedVendorId, setPickedVendorId] = useState<string | null>(null);
  // The shop it was booked with, matched by name until somebody picks another.
  const bookedVendorId = useMemo(
    () => (vendors.data ?? []).find((v) => v.name.trim().toLowerCase() === (order.vendorName ?? '').trim().toLowerCase())?.id ?? null,
    [vendors.data, order.vendorName],
  );
  const vendorId = pickedVendorId ?? bookedVendorId;
  const vendor = (vendors.data ?? []).find((v) => v.id === vendorId) ?? null;
  const [technician, setTechnician] = useState(order.assignedTo ?? '');
  const [invoiceNumber, setInvoiceNumber] = useState(order.invoiceNumber ?? '');
  const [notes, setNotes] = useState(order.notes ?? '');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      // Today means now; another day means that day, at noon Eastern-safe.
      const picked = date ?? new Date(nowMs());
      const sameDay = picked.toDateString() === new Date(nowMs()).toDateString();
      const shopInAt = sameDay ? new Date(nowMs()) : new Date(picked.getFullYear(), picked.getMonth(), picked.getDate(), 12);
      const body: CheckInWorkOrderInput = {
        workType: type,
        title: title.trim(),
        vendorId: vendor?.id ?? null,
        vendorName: vendor?.name ?? order.vendorName ?? '',
        assignedTo: technician.trim() || null,
        notes: notes.trim() || null,
        invoiceNumber: invoiceNumber.trim() || null,
        shopInAt: shopInAt.toISOString(),
      };
      return apiPost<WorkOrderDetail>(`/fleet/work-orders/${encodeURIComponent(order.id)}/check-in`, body);
    },
    onSuccess: (next) => onSaved(next),
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'The work order could not be moved into the shop.'),
  });

  const future = date !== null && date.getTime() > nowMs() + 24 * 3600_000;
  const valid = title.trim() !== '' && !future;

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      size="lg"
      title={`In shop · ${order.number}`}
      description="The booked work order goes into the shop: the unit leaves dispatch until it is completed. Correct or add anything below; the invoice is uploaded on the work order later."
      footer={
        <>
          {future ? <span className="mr-auto text-xs text-danger-text">The unit cannot go into the shop in the future.</span> : null}
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button disabled={!valid} loading={save.isPending} onClick={() => { setError(null); save.mutate(); }}>
            Move into the shop
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
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Unit (truck or trailer)" required>
            <Input autoComplete="off" readOnly aria-label="Unit (truck or trailer)" value={order.unitNumber} />
          </FormField>
          <FormField label="Type" required>
            <Select aria-label="Type" options={WORK_TYPES.map((t) => ({ value: t, label: WORK_TYPE_LABEL[t] }))} value={type} onValueChange={(v) => setType(v as WorkType)} />
          </FormField>
        </div>
        <FormField label="Title" required>
          <Input autoComplete="off" aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Status">
            <Input readOnly aria-label="Status" value="In the shop" />
          </FormField>
          <FormField label="Date" description="When it went into the shop. Today means now.">
            <DatePicker aria-label="Date" value={date} onChange={(d) => setDate(d ?? null)} />
          </FormField>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label="Vendor/shop">
            <Combobox
              aria-label="Vendor/shop"
              options={vendorOptions}
              value={vendorId}
              onValueChange={setPickedVendorId}
              placeholder={order.vendorName || 'Search vendors…'}
              searchPlaceholder="Name, city or type"
              emptyMessage="No vendor matches"
              loading={vendors.isPending}
            />
          </FormField>
          <FormField label="Technician">
            <Input autoComplete="off" aria-label="Technician" value={technician} onChange={(e) => setTechnician(e.target.value)} />
          </FormField>
        </div>
        <FormField label="Invoice #" description="The shop's invoice number; the invoice file is uploaded on the work order later.">
          <Input autoComplete="off" aria-label="Invoice #" value={invoiceNumber} onChange={(e) => setInvoiceNumber(e.target.value)} />
        </FormField>
        <FormField label="Description" description="What was reported, what the shop found.">
          <Textarea rows={3} aria-label="Description" value={notes} onChange={(e) => setNotes(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
