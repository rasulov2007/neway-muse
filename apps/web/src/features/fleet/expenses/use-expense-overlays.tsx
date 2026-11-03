import { useNavigate } from '@tanstack/react-router';
import { useState } from 'react';
import type { FleetExpenseDetail, FleetExpenseRow } from '@neway/shared';
import { ExpenseDetailDrawer } from './ExpenseDetailDrawer';
import { ExpenseFormDialog } from './ExpenseFormDialog';

/**
 * The add form and the detail panel, shared by every page that lists expenses. A row from
 * Maintenance goes to its work order instead.
 */
export function useExpenseOverlays(options: { lockedTruckId?: string; openId?: string | null; onOpenId?: (id: string | null) => void } = {}) {
  const navigate = useNavigate();
  const [localId, setLocalId] = useState<string | null>(null);
  const [form, setForm] = useState<{ open: boolean; editing: FleetExpenseDetail | null }>({ open: false, editing: null });
  const controlled = options.onOpenId !== undefined;
  const openId = controlled ? (options.openId ?? null) : localId;
  const setOpenId = (id: string | null) => (controlled ? options.onOpenId!(id) : setLocalId(id));

  const openRow = (row: FleetExpenseRow) => {
    if (row.source === 'work_order' && row.workOrderId) {
      void navigate({ to: '/fleet/maintenance/$orderId', params: { orderId: row.workOrderId } });
      return;
    }
    setOpenId(row.id);
  };

  const overlays = (
    <>
      <ExpenseDetailDrawer
        expenseId={openId}
        onClose={() => setOpenId(null)}
        onEdit={(detail) => setForm({ open: true, editing: detail })}
      />
      <ExpenseFormDialog
        open={form.open}
        onOpenChange={(open) => setForm((prev) => ({ open, editing: open ? prev.editing : null }))}
        expense={form.editing}
        lockedTruckId={options.lockedTruckId}
        onSaved={(detail) => setOpenId(detail.id)}
      />
    </>
  );

  return { openRow, addExpense: () => setForm({ open: true, editing: null }), overlays };
}
