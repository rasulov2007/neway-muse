import type { ReactNode } from 'react';
import { Button, Modal } from '@/design-system';
import { formatDate, formatDateTime, formatMoney } from '@/lib/format';
import { DASH } from '../fleet-ui';
import {
  RELAY_INVOICE_CAPTION,
  chargedPricePerGallon,
  formatGallons,
  formatPricePerGallon,
  productLabel,
  type FuelFillGroup,
} from '../fuel-ledger';

/**
 * The invoice of one fill, built from the ledger rows of that fill.
 *
 * Relay has no receipt image anywhere in its API, so nothing here pretends to be one: no logo, no
 * scanned paper, no sample. It is the itemised Relay transaction - each product line with its
 * gallons, price and total, and the sum - said plainly as such.
 */

export function FuelInvoiceLines({ fill }: { fill: FuelFillGroup }) {
  return (
    <table className="w-full text-sm">
      <caption className="sr-only">Invoice lines</caption>
      <thead>
        <tr className="border-b border-line-soft text-left text-xs text-muted">
          <th scope="col" className="py-1.5 font-semibold">
            Product
          </th>
          <th scope="col" className="py-1.5 text-right font-semibold">
            Gallons
          </th>
          <th scope="col" className="py-1.5 text-right font-semibold">
            Price / gal
          </th>
          <th scope="col" className="py-1.5 text-right font-semibold">
            Total
          </th>
        </tr>
      </thead>
      <tbody className="tabular-nums">
        {fill.lines.map((line) => (
          <tr key={line.id} className="border-b border-line-soft">
            <td className="py-1.5 text-ink">{productLabel(line.product)}</td>
            <td className="py-1.5 text-right">{formatGallons(line.gallons)}</td>
            <td className="py-1.5 text-right">
              {formatPricePerGallon(chargedPricePerGallon(line))}
            </td>
            <td className="py-1.5 text-right">{formatMoney(line.amount)}</td>
          </tr>
        ))}
      </tbody>
      <tfoot>
        <tr>
          <th scope="row" className="pt-2.5 text-left text-md font-bold text-ink">
            Total
          </th>
          <td colSpan={3} className="pt-2.5 text-right text-md font-bold text-ink tabular-nums">
            {formatMoney(fill.total)}
          </td>
        </tr>
      </tfoot>
    </table>
  );
}

/** The summary card in the Selected transaction panel. */
export function FuelInvoiceCard({ fill }: { fill: FuelFillGroup }) {
  return (
    <div className="rounded-[10px] border border-line-soft bg-surface p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <span className="text-md font-bold text-ink">{fill.lead.station.brand || DASH}</span>
        <span className="text-xs text-muted">{formatDate(fill.lead.at)}</span>
      </div>
      <FuelInvoiceLines fill={fill} />
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 py-1 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{children}</dd>
    </div>
  );
}

export interface FuelInvoiceDialogProps {
  fill: FuelFillGroup | null;
  onOpenChange: (open: boolean) => void;
}

export function FuelInvoiceDialog({ fill, onOpenChange }: FuelInvoiceDialogProps) {
  const lead = fill?.lead;
  return (
    <Modal
      open={fill !== null}
      onOpenChange={onOpenChange}
      size="md"
      title={lead ? `Fuel invoice · ${lead.station.brand || 'Unknown vendor'}` : 'Fuel invoice'}
      description={fill?.relayTransactionId ? RELAY_INVOICE_CAPTION : undefined}
      footer={
        <Button variant="secondary" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      }
    >
      {fill && lead ? (
        <div className="flex flex-col gap-4">
          <dl>
            <Field label="Vendor">{lead.station.brand || DASH}</Field>
            <Field label="Station">
              {lead.station.name ? (
                <>
                  {lead.station.name}
                  <br />
                </>
              ) : null}
              {[lead.station.city, lead.station.state].filter(Boolean).join(', ') || DASH}
            </Field>
            <Field label="Date & time">{formatDateTime(lead.at)}</Field>
            <Field label="Truck">{lead.unitNumber}</Field>
            <Field label="Driver">{lead.driverName || DASH}</Field>
            <Field label="Card">{lead.cardLast4 ? `•••• ${lead.cardLast4}` : DASH}</Field>
            <Field label="Relay transaction">
              <span className="font-mono text-xs break-all">{fill.relayTransactionId ?? DASH}</span>
            </Field>
          </dl>
          <div className="rounded-[10px] border border-line-soft p-4">
            <FuelInvoiceLines fill={fill} />
          </div>
        </div>
      ) : null}
    </Modal>
  );
}
