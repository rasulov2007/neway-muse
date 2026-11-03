import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { CDL_CLASSES, ageOn, dateOfBirthIssue, type UpdateDriverRequest } from '@neway/shared';
import { updateDriverRecord, type Driver } from '@/demo';
import { Button, DatePicker, FormField, Input, Modal, Select, useToast } from '@/design-system';
import { today } from '@/lib/clock';
import { LANGUAGES, calendarDay } from './DriverFormSchema';

/**
 * Who sees and changes a driver's date of birth: the same codes the API's `driverPiiReach().birth`
 * reads (Safety's sensitive records, Safety testing, the HR / recruiting manager; owner,
 * 2026-10-25). Anyone else gets it masked, and the server drops it from their updates.
 */
export const DATE_OF_BIRTH_PERMISSIONS = ['compliance_sensitive.view', 'safety_testing.view', 'recruiting.manage'] as const;
export const canSeeDateOfBirth = (permissions: readonly string[]) =>
  DATE_OF_BIRTH_PERMISSIONS.some((code) => permissions.includes(code));

/**
 * Edit, from the profile cards (owner's mockup, 2026-09-21): the contact card edits contact,
 * the CDL card edits the licence. Same record, same server rule as Add driver; the card shows the
 * saved row when the dialog closes.
 */
export function EditDriverDialog({
  driver,
  section,
  canEditBirth = true,
  onClose,
}: {
  driver: Driver;
  section: 'contact' | 'cdl';
  /**
   * False when the signed-in role may not see the date of birth (the API masks it and drops it
   * from an update): the field says so instead of looking empty and saving nothing.
   */
  canEditBirth?: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [phone, setPhone] = useState(driver.phone);
  const [secondaryPhone, setSecondaryPhone] = useState(driver.secondaryPhone ?? '');
  const [email, setEmail] = useState(driver.email);
  const [homeCity, setHomeCity] = useState(driver.homeCity);
  const [homeState, setHomeState] = useState(driver.homeState);
  const [language, setLanguage] = useState<string>(driver.preferredLanguage);
  const [dateOfBirth, setDateOfBirth] = useState(driver.dateOfBirth ?? '');
  const [cdlClass, setCdlClass] = useState<string>(driver.cdlClass);
  const [cdlState, setCdlState] = useState(driver.cdlState);
  const [cdlExpiresOn, setCdlExpiresOn] = useState(driver.cdlExpiresOn);
  const [medicalExpiresOn, setMedicalExpiresOn] = useState(driver.medicalCardExpiresOn);
  const [endorsements, setEndorsements] = useState(driver.cdlEndorsements.join(', '));
  const [error, setError] = useState<string | null>(null);
  const todayIso = today();
  // The same rule the API applies, read against the server's Eastern date.
  const dobIssue = canEditBirth && dateOfBirth ? dateOfBirthIssue(dateOfBirth, todayIso) : null;
  const age = dateOfBirth && !dobIssue ? ageOn(dateOfBirth, todayIso) : null;

  const save = useMutation({
    mutationFn: () => {
      if (section === 'contact' && dobIssue) throw new Error(dobIssue);
      const fields: UpdateDriverRequest =
        section === 'contact'
          ? {
              phone: phone.trim(),
              secondaryPhone: secondaryPhone.trim() || null,
              email: email.trim(),
              homeCity: homeCity.trim(),
              homeState: homeState.trim().toUpperCase(),
              preferredLanguage: language as UpdateDriverRequest['preferredLanguage'],
              ...(canEditBirth ? { dateOfBirth: dateOfBirth || null } : {}),
            }
          : {
              cdlClass: cdlClass as UpdateDriverRequest['cdlClass'],
              cdlState: cdlState.trim().toUpperCase(),
              cdlExpiresOn,
              medicalCardExpiresOn: medicalExpiresOn,
              cdlEndorsements: endorsements
                .split(',')
                .map((e) => e.trim().toUpperCase())
                .filter(Boolean),
            };
      // The version this dialog opened on: a save over somebody else's newer edit is a 409.
      const patch: UpdateDriverRequest = driver.updatedAt
        ? { ...fields, expectedUpdatedAt: driver.updatedAt }
        : fields;
      return updateDriverRecord(driver.id, patch);
    },
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['drivers'] }),
        queryClient.invalidateQueries({ queryKey: ['roster'] }),
        queryClient.invalidateQueries({ queryKey: ['compliance'] }),
      ]);
      toast({ tone: 'success', title: `${driver.name} updated` });
      onClose();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The driver could not be saved.'),
  });

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      title={section === 'contact' ? 'Edit contact information' : 'Edit CDL information'}
      description={`${driver.name} · Driver ${driver.driverNumber}`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Save changes
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
        {section === 'contact' ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Phone" required>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </FormField>
            <FormField label="Secondary phone">
              <Input value={secondaryPhone} onChange={(e) => setSecondaryPhone(e.target.value)} />
            </FormField>
            <FormField label="Email" required>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </FormField>
            <FormField label="Preferred language">
              <Select
                aria-label="Preferred language"
                options={LANGUAGES.map((o) => ({ value: o.value, label: o.label }))}
                value={language}
                onValueChange={setLanguage}
              />
            </FormField>
            <FormField label="Home city" required>
              <Input value={homeCity} onChange={(e) => setHomeCity(e.target.value)} />
            </FormField>
            <FormField label="State" required>
              <Input
                value={homeState}
                maxLength={2}
                className="uppercase"
                onChange={(e) => setHomeState(e.target.value)}
              />
            </FormField>
            <FormField
              label="Date of birth"
              error={dobIssue ?? undefined}
              description={
                !canEditBirth
                  ? 'Only Safety, the HR manager and administrators can see or change it.'
                  : dobIssue
                    ? undefined
                    : age !== null
                      ? `${age} years old.`
                      : 'Optional.'
              }
            >
              <DatePicker
                aria-label="Date of birth"
                disabled={!canEditBirth}
                placeholder={canEditBirth ? 'MM/DD/YYYY' : 'Restricted'}
                value={dateOfBirth}
                onIsoChange={(iso) => setDateOfBirth(iso ?? '')}
                maxDate={calendarDay(todayIso)}
                invalid={Boolean(dobIssue)}
              />
            </FormField>
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="CDL class" required>
              <Select
                aria-label="CDL class"
                options={CDL_CLASSES.map((c) => ({ value: c, label: `Class ${c}` }))}
                value={cdlClass}
                onValueChange={setCdlClass}
              />
            </FormField>
            <FormField label="State" required>
              <Input
                value={cdlState}
                maxLength={2}
                className="uppercase"
                onChange={(e) => setCdlState(e.target.value)}
              />
            </FormField>
            <FormField label="CDL expires" required>
              <DatePicker value={cdlExpiresOn} onIsoChange={(iso) => setCdlExpiresOn(iso ?? '')} />
            </FormField>
            <FormField label="Medical card expires" required>
              <DatePicker
                value={medicalExpiresOn}
                onIsoChange={(iso) => setMedicalExpiresOn(iso ?? '')}
              />
            </FormField>
            <FormField
              label="Endorsements"
              description="Comma separated: H, N, T, X."
              className="sm:col-span-2"
            >
              <Input
                value={endorsements}
                onChange={(e) => setEndorsements(e.target.value)}
                placeholder="None"
              />
            </FormField>
          </div>
        )}
      </div>
    </Modal>
  );
}
