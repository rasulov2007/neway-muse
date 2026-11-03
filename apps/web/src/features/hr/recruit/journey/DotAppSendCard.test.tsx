import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { RecruitCandidate } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { SendDotAppModal, previewMessage } from './DotAppSendCard';

const candidate = { key: 'case_1', name: 'Ali Karimov', firstName: 'Ali', lastName: 'Karimov', email: 'ali@example.com', driverId: 'drv_2118' } as unknown as RecruitCandidate;

describe('Send DOT application', () => {
  it('offers email from NeWay and copy link — and no SMS', async () => {
    renderPage(<SendDotAppModal candidate={candidate} reservedId="drv_2118" resend={false} onClose={() => {}} />);
    const modal = await screen.findByTestId('dot-app-send-modal');
    const channels = within(modal).getByTestId('dot-app-channels');
    const boxes = within(channels).getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(within(channels).getByText('Email from NeWay')).toBeInTheDocument();
    expect(within(channels).getByText('Copy link + message')).toBeInTheDocument();
    expect(within(channels).queryByText(/sms|text message/i)).toBeNull();
    expect(within(modal).queryByRole('checkbox', { name: /sms|text/i })).toBeNull();
    expect(within(modal).getByText('D-2118')).toBeInTheDocument();
    expect(within(modal).getByRole('combobox', { name: 'Link expires in' })).toBeInTheDocument();
  });

  it('tells the driver a 6-digit code comes by email', () => {
    const text = previewMessage({ firstName: 'Ali', company: 'HARBOR LINE TRANSPORT INC', url: null, email: 'ali@example.com', expiresInDays: 7 });
    expect(text).toContain('6-digit code');
    expect(text).toContain('ali@example.com');
    expect(text).toContain('HARBOR LINE TRANSPORT INC');
    expect(text).not.toMatch(/SSN|date of birth/i);
  });
});
