import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { CdlExtractSchema, CDL_READ_FIELDS, type CdlReadResult } from '@neway/shared';
import { CdlMuseReading } from './CdlMuseReading';

const photo = new File(['x'], 'cdl.png', { type: 'image/png' });
const extract = CdlExtractSchema.parse({
  legalFirstName: 'JORDAN',
  legalLastName: 'SAMPLETON',
  dateOfBirth: '1988-03-14',
  cdlNumber: 'S530-4412-8890',
  issuingState: 'IL',
  cdlClass: 'A',
  endorsements: ['N', 'T'],
  cdlExpiresOn: '2028-06-01',
  needsReview: ['cdlIssuedOn'],
  source: 'ocr',
});
const result: CdlReadResult = {
  extract,
  confidence: Object.fromEntries(CDL_READ_FIELDS.map((f) => [f, f === 'cdlIssuedOn' ? 0.4 : 0.97])) as CdlReadResult['confidence'],
  warnings: [{ field: 'dateOfBirth', tone: 'warning', message: 'Date of birth on the card (1988-03-14) differs from the application (1988-03-15).' }],
  compared: true,
  model: 'muse-spark-1.3',
  ms: 5200,
};

const props = {
  file: photo,
  draft: extract,
  confirmed: false,
  onRead: vi.fn(),
  onDraftChange: vi.fn(),
  onConfirmedChange: vi.fn(),
};

describe('CdlMuseReading', () => {
  it('says Reading… while Muse reads', () => {
    render(<CdlMuseReading {...props} draft={null} state={{ status: 'reading' }} />);
    expect(screen.getByRole('status')).toHaveTextContent('Reading…');
  });

  it('shows each field with a word for how sure it is, and mismatches as symbol + word', async () => {
    render(<CdlMuseReading {...props} state={{ status: 'done', result }} />);
    expect(screen.getByText('Mismatch', { selector: 'span.font-semibold' })).toBeInTheDocument();
    expect(screen.getByText(/differs from the application/)).toBeInTheDocument();
    expect(screen.getByLabelText('CDL number')).toHaveValue('S530-4412-8890');
    expect(screen.getByText('Check · 40%')).toBeInTheDocument();
    expect(screen.getByText(/Read\b/, { selector: 'span' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox'));
    expect(props.onConfirmedChange).toHaveBeenCalledWith(true);
  });

  it('says why a file cannot be read', () => {
    render(
      <CdlMuseReading
        {...props}
        file={new File(['x'], 'cdl.heic', { type: 'image/heic' })}
        draft={null}
        state={{ status: 'idle' }}
      />,
    );
    expect(screen.getByText(/Muse reads PDFs and photos/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Read with Muse/ })).toBeDisabled();
  });
});
