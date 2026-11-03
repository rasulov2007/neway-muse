import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import {
  FLEET_VENDOR_KINDS,
  VENDOR_KIND_LABEL,
  createVendor,
  updateVendor,
  type Vendor,
  type VendorInput,
  type VendorKind,
} from '@/demo';
import { Button, FormField, IconButton, Input, Modal, Select, Textarea, useToast } from '@/design-system';
import { FormBlock, FormBlockWide } from '@/features/forms/FormBlock';

/**
 * Adding a vendor without leaving the work order.
 *
 * The shop that just quoted the job is not on the list, and the person is half way through the
 * order. This opens on top of that dialog, saves the vendor, and hands it back selected — nothing
 * typed into the order is lost. The same form edits a vendor from its own page.
 *
 * Only the name is required. Phone, address, contacts and the account number are collected when
 * somebody has them in front of them, not invented to fill the record.
 */

interface ContactDraft {
  id?: string;
  name: string;
  role: string;
  phone: string;
  email: string;
}

export function VendorFormDialog({
  name = '',
  vendor,
  onClose,
  onSaved,
}: {
  /** The name typed into the picker, when creating. */
  name?: string;
  /** The record to edit; absent when creating. */
  vendor?: Vendor;
  onClose: () => void;
  onSaved: (vendor: Vendor) => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<VendorInput>({
    name: vendor?.name ?? name,
    kind: vendor?.kind ?? 'shop',
    phone: vendor?.phone ?? '',
    street: vendor?.street ?? '',
    city: vendor?.city ?? '',
    state: vendor?.state ?? '',
    zip: vendor?.zip ?? '',
    email: vendor?.email ?? vendor?.contactEmail ?? '',
    website: vendor?.website ?? '',
    accountNumber: vendor?.accountNumber ?? '',
    paymentTermsDays: vendor?.paymentTermsDays ?? 30,
    notes: vendor?.notes ?? '',
    status: vendor?.status ?? 'active',
  });
  const [contacts, setContacts] = useState<ContactDraft[]>(
    (vendor?.contacts ?? []).map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role ?? '',
      phone: c.phone ?? '',
      email: c.email ?? '',
    })),
  );
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof VendorInput>(key: K, value: VendorInput[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const save = useMutation({
    mutationFn: () => {
      const input: VendorInput = { ...form, contacts };
      return vendor ? updateVendor(vendor.id, input) : createVendor(input);
    },
    onSuccess: async (saved) => {
      await queryClient.invalidateQueries({ queryKey: ['fleet'] });
      await queryClient.invalidateQueries({ queryKey: ['vendors'] });
      toast({ tone: 'success', title: vendor ? `${saved.name} saved` : `${saved.name} added to vendors` });
      onSaved(saved);
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'The vendor could not be saved.'),
  });

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="lg"
      title={vendor ? `Edit ${vendor.name}` : 'Create vendor'}
      description={
        vendor
          ? 'The record every work order with this vendor reads.'
          : 'Only the name is required; the rest can be added when it is to hand.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={!form.name.trim()}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            {vendor ? 'Save vendor' : 'Create vendor'}
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
        <FormBlock title="Vendor">
          <FormField label="Name" required>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
          </FormField>
          <FormField label="Type">
            <Select
              options={FLEET_VENDOR_KINDS.map((kind) => ({ value: kind, label: VENDOR_KIND_LABEL[kind] }))}
              value={form.kind}
              onValueChange={(value) => set('kind', value as VendorKind)}
            />
          </FormField>
          <FormField label="Phone">
            <Input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} placeholder="+1 (630) 555-0100" />
          </FormField>
          <FormField label="Email">
            <Input type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} />
          </FormField>
          <FormField label="Website">
            <Input value={form.website ?? ''} onChange={(e) => set('website', e.target.value)} placeholder="https://" />
          </FormField>
          <FormField label="Our account number with them">
            <Input value={form.accountNumber ?? ''} onChange={(e) => set('accountNumber', e.target.value)} />
          </FormField>
        </FormBlock>
        <FormBlock title="Address">
          <FormBlockWide>
            <FormField label="Street">
              <Input value={form.street ?? ''} onChange={(e) => set('street', e.target.value)} />
            </FormField>
          </FormBlockWide>
          <FormField label="City">
            <Input value={form.city ?? ''} onChange={(e) => set('city', e.target.value)} />
          </FormField>
          <div className="grid grid-cols-2 gap-4">
            <FormField label="State">
              <Input value={form.state ?? ''} onChange={(e) => set('state', e.target.value)} maxLength={2} />
            </FormField>
            <FormField label="ZIP">
              <Input value={form.zip ?? ''} onChange={(e) => set('zip', e.target.value)} />
            </FormField>
          </div>
        </FormBlock>
        <FormBlock title="Terms and notes">
          <FormField label="Payment terms (days)">
            <Input
              type="number"
              min={0}
              value={String(form.paymentTermsDays ?? 30)}
              onChange={(e) => set('paymentTermsDays', Number(e.target.value) || 0)}
            />
          </FormField>
          {vendor ? (
            <FormField label="Status">
              <Select
                options={[
                  { value: 'active', label: 'Active' },
                  { value: 'inactive', label: 'Inactive' },
                ]}
                value={form.status ?? 'active'}
                onValueChange={(value) => set('status', value as Vendor['status'])}
              />
            </FormField>
          ) : null}
          <FormBlockWide>
            <FormField label="Notes">
              <Textarea rows={2} value={form.notes ?? ''} onChange={(e) => set('notes', e.target.value)} />
            </FormField>
          </FormBlockWide>
        </FormBlock>
        <FormBlock title="Additional contacts" hint="Optional. Offered as technician suggestions on work orders.">
          <FormBlockWide>
            <div className="flex flex-col gap-2">
              {contacts.map((contact, index) => (
                <div key={contact.id ?? index} className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_1fr_auto]">
                  <Input
                    aria-label="Contact name"
                    placeholder="Name"
                    value={contact.name}
                    onChange={(e) => setContacts((c) => c.map((x, i) => (i === index ? { ...x, name: e.target.value } : x)))}
                  />
                  <Input
                    aria-label="Contact role"
                    placeholder="Role"
                    value={contact.role}
                    onChange={(e) => setContacts((c) => c.map((x, i) => (i === index ? { ...x, role: e.target.value } : x)))}
                  />
                  <Input
                    aria-label="Contact phone"
                    placeholder="Phone"
                    value={contact.phone}
                    onChange={(e) => setContacts((c) => c.map((x, i) => (i === index ? { ...x, phone: e.target.value } : x)))}
                  />
                  <Input
                    aria-label="Contact email"
                    placeholder="Email"
                    value={contact.email}
                    onChange={(e) => setContacts((c) => c.map((x, i) => (i === index ? { ...x, email: e.target.value } : x)))}
                  />
                  <IconButton
                    label="Remove contact"
                    variant="ghost"
                    onClick={() => setContacts((c) => c.filter((_, i) => i !== index))}
                  >
                    <Trash2 />
                  </IconButton>
                </div>
              ))}
              <div>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Plus />}
                  onClick={() => setContacts((c) => [...c, { name: '', role: '', phone: '', email: '' }])}
                >
                  Add contact
                </Button>
              </div>
            </div>
          </FormBlockWide>
        </FormBlock>
      </div>
    </Modal>
  );
}
