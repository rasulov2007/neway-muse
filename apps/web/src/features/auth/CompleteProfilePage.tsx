import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Loader2 } from 'lucide-react';
import type { SelfProfile, SelfProfileRequest } from '@neway/shared';
import { Alert, Button, DatePicker, FormField, Input } from '@/design-system';
import { ApiError, apiGet, apiPut } from '@/lib/api-client';
import { forgetStoredAccount } from '@/lib/session';
import { useAuth } from './auth-context';


/**
 * Complete your profile (owner, 2026-10-26).
 *
 * The first thing a new account sees after its password: the person fills in their own employee
 * information, and nothing else in the product opens until they do - the API refuses every other
 * route for the session, so this is a gate and not a reminder. Only what somebody can know about
 * themselves is asked; department, title, role and pay stay with HR and the administrator, and
 * the email is the account's own, read-only.
 */
export function CompleteProfilePage() {
  const { account, signOut } = useAuth();
  const profile = useQuery({
    queryKey: ['me', 'profile'],
    queryFn: () => apiGet<SelfProfile>('/me/profile'),
    retry: false,
  });

  return (
    <div className="flex min-h-screen justify-center bg-nw-bg px-4 py-10">
      <div className="w-full max-w-[640px]">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <span
            className="flex size-11 items-center justify-center rounded-lg bg-nw-accent text-lg font-black text-nw-on-accent select-none"
            aria-hidden
          >
            N
          </span>
          <h1 className="text-xl font-bold text-nw-text">Complete your profile</h1>
          <p className="text-sm text-nw-text-2">
            Fill in your own information before you start. Your department, title and pay are set by
            HR.
          </p>
        </div>

        {profile.isPending ? (
          <div className="flex items-center justify-center gap-2 rounded-lg border border-nw-border bg-nw-panel p-10 text-sm text-nw-text-2">
            <Loader2 className="size-4 animate-spin" aria-hidden /> Loading…
          </div>
        ) : profile.isError ? (
          <Alert
            tone="danger"
            title="Your profile could not be loaded"
            description={profile.error instanceof ApiError ? profile.error.message : 'Try again in a moment.'}
          />
        ) : (
          <ProfileForm profile={profile.data} accountName={account?.name ?? ''} onSignOut={() => void signOut()} />
        )}
      </div>
    </div>
  );
}

function ProfileForm({
  profile,
  accountName,
  onSignOut,
}: {
  profile: SelfProfile;
  accountName: string;
  onSignOut: () => void;
}) {
  const start = profile.employee;
  const [fullName, setFullName] = useState(start?.fullName ?? accountName);
  const [nickname, setNickname] = useState(start?.nickname ?? '');
  const [dateOfBirth, setDateOfBirth] = useState(start?.dateOfBirth ?? '');
  const [idNumber, setIdNumber] = useState(start?.idNumber ?? '');
  const [homeAddress, setHomeAddress] = useState(start?.homeAddress ?? '');
  const [phone, setPhone] = useState(start?.phone ?? '');
  const [secondaryPhone, setSecondaryPhone] = useState(start?.secondaryPhone ?? '');
  const [shiftTime, setShiftTime] = useState(start?.shiftTime ?? '');
  const [error, setError] = useState<string | null>(null);

  const names = fullName.trim().split(/\s+/).filter(Boolean);
  // What is still missing, said out loud (owner, 2026-10-27: a silently disabled button looked broken).
  const missing = [
    names.length >= 2 ? null : 'Full name (first and last name)',
    shiftTime.trim().length > 0 ? null : 'Shift time',
    phone.replace(/\D/g, '').length >= 7 ? null : 'Primary phone',
  ].filter((m): m is string => m !== null);
  const valid = missing.length === 0;
  const [tried, setTried] = useState(false);
  const show = (field: string) => tried && missing.some((m) => m.startsWith(field));

  const submit = useMutation({
    mutationFn: () => {
      const body: SelfProfileRequest = {
        fullName: fullName.trim(),
        nickname: nickname.trim() || null,
        dateOfBirth: dateOfBirth || null,
        idNumber: idNumber.trim() || null,
        homeAddress: homeAddress.trim() || null,
        phone: phone.trim(),
        secondaryPhone: secondaryPhone.trim() || null,
        shiftTime: shiftTime.trim(),
        // Location is no longer asked here (owner, 2026-10-26); whatever HR recorded stays.
        location: start?.location ?? null,
        expectedUpdatedAt: start?.updatedAt ?? null,
      };
      return apiPut<SelfProfile>('/me/profile', body);
    },
    onSuccess: () => {
      // The stored account still says the profile is required; drop it so the next boot asks.
      forgetStoredAccount();
      window.location.href = '/';
    },
    onError: (err: unknown) =>
      setError(err instanceof ApiError ? err.message || 'Your profile was not saved.' : 'Your profile was not saved.'),
  });

  return (
    <div className="flex flex-col gap-4">
      <Alert
        tone="warning"
        title="Anyone who enters false information will be fined."
        description="Check every field before you submit. HR compares this with your documents."
      />

      <form
        className="flex flex-col gap-5 rounded-lg border border-nw-border bg-nw-panel p-6"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setTried(true);
          if (valid) submit.mutate();
          else setError(`Fill in: ${missing.join(', ')}.`);
        }}
      >
        <Section title="Identity">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Full name" required description="First and last name." error={show('Full name') ? 'Enter your first and last name.' : undefined}>
              <Input aria-label="Full name" value={fullName} onChange={(e) => setFullName(e.target.value)} autoFocus />
            </FormField>
            <FormField label="Nickname" description="Shown on the boards instead of your name.">
              <Input aria-label="Nickname" value={nickname} onChange={(e) => setNickname(e.target.value)} />
            </FormField>
            <FormField label="Date of birth">
              <DatePicker aria-label="Date of birth" value={dateOfBirth} onIsoChange={(iso) => setDateOfBirth(iso ?? '')} />
            </FormField>
            <FormField label="Passport / ID number">
              <Input aria-label="Passport / ID number" value={idNumber} onChange={(e) => setIdNumber(e.target.value)} />
            </FormField>
          </div>
          <FormField label="Home address">
            <Input aria-label="Home address" value={homeAddress} onChange={(e) => setHomeAddress(e.target.value)} />
          </FormField>
        </Section>

        <Section title="Work">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Shift time" required error={show('Shift time') ? 'Type your shift, e.g. 6 PM – 6 AM.' : undefined}>
              <Input
                aria-label="Shift time"
                value={shiftTime}
                onChange={(e) => setShiftTime(e.target.value)}
                placeholder="e.g. 6 PM – 6 AM Eastern"
              />
            </FormField>
          </div>
        </Section>

        <Section title="Contact">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Primary phone" required error={show('Primary phone') ? 'Enter a phone number (at least 7 digits).' : undefined}>
              <Input aria-label="Primary phone" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} />
            </FormField>
            <FormField label="Secondary phone (emergency)">
              <Input
                aria-label="Secondary phone (emergency)"
                inputMode="tel"
                value={secondaryPhone}
                onChange={(e) => setSecondaryPhone(e.target.value)}
              />
            </FormField>
          </div>
          <FormField label="Email" description="Your sign-in email. Ask an administrator to change it.">
            <Input aria-label="Email" type="email" value={profile.email} readOnly />
          </FormField>
        </Section>

        {error ? (
          <p
            role="alert"
            className="rounded-md border border-nw-urgent-border bg-nw-urgent-bg px-3 py-2 text-sm text-nw-urgent-text"
          >
            {error}
          </p>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-auto text-xs text-nw-text-3">
            <span aria-hidden className="text-nw-urgent-text">
              *
            </span>{' '}
            Required fields
          </span>
          <Button type="button" variant="ghost" onClick={onSignOut}>
            Sign out
          </Button>
          <Button type="submit" variant="primary" disabled={submit.isPending}>
            {submit.isPending ? (
              <>
                <Loader2 className="animate-spin" aria-hidden /> Saving…
              </>
            ) : (
              'Submit and continue'
            )}
          </Button>
        </div>
      </form>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-[11px] font-bold tracking-[.08em] text-nw-text-2 uppercase">{title}</h2>
      {children}
    </section>
  );
}
