import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { EvaluatedItem } from '@neway/shared';
import { ToastProvider } from '@/design-system/components/Toast';

/** The Safety attach dialog asks which paper a Work authorization is (owner, 2026-10-26). */

const upload = vi.fn(async (input: { title: string }) => ({ document: { id: 'doc_1', title: input.title } }));
vi.mock('./compliance-api', () => ({ uploadComplianceDocument: (input: { title: string }) => upload(input) }));

const { UploadDocumentDialog } = await import('./UploadDocumentDialog');

const item = (code: string, name: string) =>
  ({
    itemId: null,
    requirementCode: code,
    requirementName: name,
    scope: 'driver',
    entityId: 'drv_1',
    entityLabel: 'Ali Karimov',
    status: 'missing',
    severity: 'ok',
    expiresOn: null,
    daysRemaining: null,
    warningStage: null,
    inGracePeriod: false,
    blocksDispatch: false,
    owner: 'recruiter',
    notify: [],
    reasons: [],
    requiredAction: null,
    deadline: null,
  }) as unknown as EvaluatedItem;

function renderDialog(code: string, name: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <UploadDocumentDialog item={item(code, name)} ownerType="driver" open onOpenChange={() => {}} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Safety attach dialog · Work authorization type', () => {
  it('requires the type and files it with the document', async () => {
    renderDialog('work_authorization', 'Work authorization');
    const file = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(file, { target: { files: [new File(['%PDF'], 'ead.pdf', { type: 'application/pdf' })] } });
    const attach = screen.getByRole('button', { name: 'Attach document' }) as HTMLButtonElement;
    expect(attach.disabled).toBe(true);
    await userEvent.click(screen.getByRole('combobox', { name: 'Work authorization type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Employment Authorization' }));
    expect(attach.disabled).toBe(false);
    await userEvent.click(attach);
    await waitFor(() => expect(upload).toHaveBeenCalled());
    expect(upload.mock.calls[0]![0]).toMatchObject({ extracted: { workAuthorizationKind: 'employment_authorization' } });
  });

  it('does not ask for any other requirement', () => {
    renderDialog('medical_card', 'Medical card');
    expect(screen.queryByRole('combobox', { name: 'Work authorization type' })).toBeNull();
  });
});
