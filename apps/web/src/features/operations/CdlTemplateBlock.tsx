import { CDL_EXTRACT_LABEL, type CdlExtract } from '@neway/shared';
import { DatePicker, FormField, Input, cn } from '@/design-system';
import { FormBlock } from '@/features/forms/FormBlock';

/**
 * What the two cards say, as a file Safety can keep.
 *
 * The roster already holds the four facts dispatch runs on — state, class, endorsements, expiry —
 * and they are entered above. These are the rest of what is printed: the legal name, the date of
 * birth, the licence number, restrictions, the examiner's certificate. Safety needs them; nobody
 * needs them twice, so they live on the document they were read from.
 *
 * Everything the reader filled in is editable, and everything it was unsure of is marked. A field
 * flagged "Needs review" is one the machine looked for and did not find — the person checks one
 * box instead of re-reading the whole licence.
 */
export function CdlTemplateBlock({
  value,
  onChange,
  disabled,
  showLegalName = true,
  showMedical = true,
  showDateOfBirth = true,
}: {
  value: CdlExtract;
  onChange: (next: CdlExtract) => void;
  disabled?: boolean;
  /**
   * Whether the three legal-name fields are shown. The driver form hides them until the person
   * says the licence carries a different name; the primary name is filed as the legal one then.
   */
  showLegalName?: boolean;
  /** The roster form leaves the DOT medical card to Recruiting (owner, 2026-10-12). */
  showMedical?: boolean;
  /**
   * The driver form asks for the date of birth once, on the driver (owner, 2026-10-25), and files
   * it with the licence; a second field here would let the two disagree.
   */
  showDateOfBirth?: boolean;
}) {
  const set = <K extends keyof CdlExtract>(field: K, next: CdlExtract[K]) =>
    onChange({
      ...value,
      [field]: next,
      // Correcting a flagged field is the review; the mark comes off with the correction.
      needsReview: value.needsReview.filter((name) => name !== field),
    });

  const flagged = (field: string) => value.needsReview.includes(field);

  const text = (field: keyof CdlExtract & string, placeholder?: string, maxLength?: number) => (
    <FormField
      label={CDL_EXTRACT_LABEL[field as keyof typeof CDL_EXTRACT_LABEL] ?? field}
      description={flagged(field) ? 'Needs review — read this one off the card.' : undefined}
    >
      <Input
        value={(value[field] as string | null) ?? ''}
        disabled={disabled}
        placeholder={placeholder}
        maxLength={maxLength}
        className={cn(flagged(field) && 'border-warning-border bg-warning-soft')}
        onChange={(event) => set(field, (event.target.value || null) as never)}
      />
    </FormField>
  );

  const date = (field: keyof CdlExtract & string) => (
    <FormField
      label={CDL_EXTRACT_LABEL[field as keyof typeof CDL_EXTRACT_LABEL] ?? field}
      description={flagged(field) ? 'Needs review — read this one off the card.' : undefined}
    >
      <DatePicker
        value={(value[field] as string | null) ?? ''}
        disabled={disabled}
        className={cn(flagged(field) && 'border-warning-border bg-warning-soft')}
        onIsoChange={(event) => set(field, (event || null) as never)}
      />
    </FormField>
  );

  return (
    <FormBlock
      title={showMedical ? 'CDL and medical details' : 'CDL details'}
      hint={
        value.source === 'ocr'
          ? 'Read from the cards you attached. Everything here must match the licence card exactly — check it against the paper before saving, because what is saved is what Safety files.'
          : 'Filed with the licence. Everything here must match the licence card exactly; nothing is required to add the driver.'
      }
    >
      {showLegalName ? text('legalFirstName', 'James') : null}
      {showLegalName ? text('legalMiddleName', 'Robert') : null}
      {showLegalName ? text('legalLastName', 'Wilson') : null}
      {showDateOfBirth ? date('dateOfBirth') : null}
      {text('cdlNumber', 'W123-4567-8901', 30)}
      {date('cdlIssuedOn')}
      <FormField
        label={CDL_EXTRACT_LABEL.restrictions}
        description="As printed, comma separated. Blank means none."
      >
        <Input
          value={value.restrictions.join(', ')}
          disabled={disabled}
          placeholder="L, Z"
          onChange={(event) =>
            set(
              'restrictions',
              event.target.value
                .split(',')
                .map((code) => code.trim().toUpperCase())
                .filter(Boolean),
            )
          }
        />
      </FormField>
      {showMedical ? date('medicalIssuedOn') : null}
      {showMedical ? text('medicalCertificateNumber', '1234567890', 40) : null}
      {showMedical ? text('medicalExaminerName', 'Dr Alan Reyes', 80) : null}
    </FormBlock>
  );
}
