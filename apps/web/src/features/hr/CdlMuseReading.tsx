import { Sparkles } from 'lucide-react';
import {
  CDL_EXTRACT_LABEL,
  CDL_READ_FIELDS,
  CDL_READ_TYPES,
  CDL_REVIEW_BELOW,
  type CdlExtract,
  type CdlReadField,
  type CdlReadResult,
  type CdlReadWarningTone,
} from '@neway/shared';
import { Button, Checkbox, Input, StatusSymbol, cn, type StatusSymbolFamily } from '@/design-system';

/**
 * Read with Muse (hackathon, 2026-11-03): the licence photo is read by Meta Muse and every field
 * lands here as an editable value with how sure the model was. Nothing is saved until the
 * recruiter ticks that they checked the fields against the card and uploads; differences from
 * the DOT application are listed above the fields, each as a symbol and a word.
 */

export type CdlReadingState =
  | { status: 'idle' }
  | { status: 'reading' }
  | { status: 'error'; message: string }
  | { status: 'done'; result: CdlReadResult };

export function canMuseRead(file: File | null): boolean {
  return Boolean(file && (CDL_READ_TYPES as readonly string[]).includes(file.type));
}

const WARNING_LOOK: Record<
  CdlReadWarningTone,
  { family: StatusSymbolFamily; word: string; text: string; icon: string }
> = {
  urgent: { family: 'urgent', word: 'Stop', text: 'text-danger-text', icon: 'text-nw-urgent-icon' },
  warning: { family: 'warning', word: 'Mismatch', text: 'text-warning-text', icon: 'text-nw-warning-icon' },
  info: { family: 'info', word: 'Note', text: 'text-info-text', icon: 'text-nw-info-icon' },
};

const DATE_FIELDS: CdlReadField[] = ['dateOfBirth', 'cdlIssuedOn', 'cdlExpiresOn'];
const LIST_FIELDS: CdlReadField[] = ['endorsements', 'restrictions'];

function asText(extract: CdlExtract, field: CdlReadField): string {
  const value = extract[field];
  if (Array.isArray(value)) return value.join(', ');
  return value ?? '';
}

function withText(extract: CdlExtract, field: CdlReadField, text: string): CdlExtract {
  if (LIST_FIELDS.includes(field)) {
    const codes = text
      .toUpperCase()
      .split(/[\s,;]+/)
      .map((c) => c.trim())
      .filter((c) => c && c.length <= 3);
    return { ...extract, [field]: codes };
  }
  const trimmed = text.trim();
  if (field === 'issuingState') return { ...extract, issuingState: trimmed ? trimmed.toUpperCase().slice(0, 2) : null };
  if (field === 'cdlClass') {
    const cls = trimmed.toUpperCase();
    return { ...extract, cdlClass: cls === 'A' || cls === 'B' || cls === 'C' ? cls : null };
  }
  return { ...extract, [field]: trimmed || null };
}

export function CdlMuseReading({
  file,
  state,
  draft,
  confirmed,
  onRead,
  onDraftChange,
  onConfirmedChange,
}: {
  file: File | null;
  state: CdlReadingState;
  draft: CdlExtract | null;
  confirmed: boolean;
  onRead: () => void;
  onDraftChange: (next: CdlExtract) => void;
  onConfirmedChange: (next: boolean) => void;
}) {
  const readable = canMuseRead(file);
  return (
    <section
      className="flex flex-col gap-3 rounded-lg border border-line bg-nw-panel p-3"
      aria-label="Read with Muse"
      data-testid="cdl-muse-reading"
    >
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-bold text-ink">Read with Muse</h4>
          <p className="text-xs text-muted">
            Meta Muse reads the licence and fills the fields. Check each one against the card before
            you upload.
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          icon={<Sparkles />}
          disabled={!readable || state.status === 'reading'}
          loading={state.status === 'reading'}
          onClick={onRead}
        >
          {state.status === 'done' ? 'Read again' : 'Read with Muse'}
        </Button>
      </div>

      {!file ? (
        <p className="text-xs text-muted">Choose the licence photo or PDF first.</p>
      ) : !readable ? (
        <p className="text-xs text-muted">Muse reads PDFs and photos (JPEG, PNG, WebP).</p>
      ) : null}

      {state.status === 'reading' ? (
        <p className="flex items-center gap-1.5 text-sm text-ink" role="status" aria-live="polite">
          <StatusSymbol family="moving" size={14} className="text-nw-moving-icon" />
          <span className="font-semibold">Reading…</span>
          <span className="text-xs text-muted">usually 10–30 seconds</span>
        </p>
      ) : null}

      {state.status === 'error' ? (
        <p className="flex items-center gap-1.5 text-sm text-danger-text" role="alert">
          <StatusSymbol family="urgent" size={14} className="text-nw-urgent-icon" />
          <span className="font-semibold">Not read</span>
          <span>{state.message}</span>
        </p>
      ) : null}

      {state.status === 'done' && draft ? (
        <>
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <StatusSymbol family="done" size={13} className="text-nw-done-icon" />
            <span className="font-semibold text-ink">Read</span>
            in {(state.result.ms / 1000).toFixed(1)} s by {state.result.model}
            {state.result.compared ? ' · compared with the DOT application' : null}
          </p>

          {state.result.warnings.length > 0 ? (
            <ul className="flex flex-col gap-1.5" data-testid="cdl-muse-warnings">
              {state.result.warnings.map((w, i) => {
                const look = WARNING_LOOK[w.tone];
                return (
                  <li key={i} className="flex items-start gap-1.5 text-sm">
                    <StatusSymbol
                      family={look.family}
                      size={14}
                      className={cn('mt-0.5 shrink-0', look.icon)}
                    />
                    <span className={cn('font-semibold', look.text)}>{look.word}</span>
                    <span className="text-ink">{w.message}</span>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="flex items-center gap-1.5 text-sm">
              <StatusSymbol family="done" size={14} className="text-nw-done-icon" />
              <span className="font-semibold text-success-text">Matches</span>
              <span className="text-ink">Nothing on the card disagrees with the application.</span>
            </p>
          )}

          <div className="grid grid-cols-1 gap-x-4 gap-y-2 sm:grid-cols-2">
            {CDL_READ_FIELDS.map((field) => {
              const confidence = state.result.confidence[field];
              const check =
                confidence < CDL_REVIEW_BELOW || state.result.extract.needsReview.includes(field);
              const flagged = state.result.warnings.some((w) => w.field === field);
              return (
                <label key={field} className="flex min-w-0 flex-col gap-1">
                  <span className="flex items-center justify-between gap-2 text-xs text-muted">
                    <span>{CDL_EXTRACT_LABEL[field]}</span>
                    <span className="flex items-center gap-1" title={`Confidence ${Math.round(confidence * 100)}%`}>
                      <StatusSymbol
                        family={check || flagged ? 'warning' : 'done'}
                        size={12}
                        className={check || flagged ? 'text-nw-warning-icon' : 'text-nw-done-icon'}
                      />
                      <span className={check || flagged ? 'text-warning-text' : 'text-success-text'}>
                        {check ? 'Check' : flagged ? 'Mismatch' : 'Sure'} · {Math.round(confidence * 100)}%
                      </span>
                    </span>
                  </span>
                  <Input
                    type={DATE_FIELDS.includes(field) ? 'date' : 'text'}
                    value={asText(draft, field)}
                    aria-label={CDL_EXTRACT_LABEL[field]}
                    invalid={check || flagged}
                    onChange={(e) => onDraftChange(withText(draft, field, e.target.value))}
                  />
                </label>
              );
            })}
          </div>

          <Checkbox
            checked={confirmed}
            onCheckedChange={(next) => onConfirmedChange(next === true)}
            label="I checked these fields against the licence"
            description="Only a checked reading is kept on the driver file. The expiry above becomes the CDL's expiry date."
          />
        </>
      ) : null}
    </section>
  );
}
