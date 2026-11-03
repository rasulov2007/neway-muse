import { useState } from 'react';
import { Copy, ExternalLink, Link2, Plus } from 'lucide-react';
import { APPLICANT_SOURCES, type ApplyLink } from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  FormField,
  Input,
  Modal,
  Select,
  Textarea,
  useToast,
} from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { formatRelative } from '@/lib/format';
import { applyUrl } from './apply-url';
import { hiringApi, useApplyLinks, useCampaigns, useHiringMutation } from './useHiring';

/**
 * Public application links.
 *
 * A link is what goes into an Instagram ad or a post. It carries the company (resolved on the
 * server, never by the driver's browser), the source and campaign every lead from it is recorded
 * under, and the consent wording the driver agrees to. The wording is the company's own: NeWay
 * supplies none, and a link cannot be created without it.
 */
export function ApplyLinksModal({ onClose }: { onClose: () => void }) {
  const links = useApplyLinks();
  const [creating, setCreating] = useState(false);
  const { toast } = useToast();
  const toggle = useHiringMutation((l: ApplyLink) =>
    hiringApi.updateApplyLink(l.id, { active: !l.active }),
  );

  const copy = async (link: ApplyLink) => {
    try {
      await navigator.clipboard.writeText(applyUrl(link.slug));
      toast({ title: 'Link copied', tone: 'success' });
    } catch {
      toast({ title: `Copy this address: ${applyUrl(link.slug)}`, tone: 'info' });
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
      title={creating ? 'New application link' : 'Application links'}
      description={
        creating
          ? 'Drivers who open this link can apply in about 30 seconds. Their application arrives here as a New lead.'
          : 'Share a link in an ad or a post. Every application arrives in Leads with its answers, source and campaign.'
      }
      size="lg"
      footer={
        creating ? null : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button icon={<Plus />} onClick={() => setCreating(true)}>
              New link
            </Button>
          </>
        )
      }
    >
      {creating ? (
        <CreateLinkForm onDone={() => setCreating(false)} />
      ) : links.error ? (
        <Alert
          tone="danger"
          title="Links could not be loaded"
          description={links.error instanceof Error ? links.error.message : undefined}
        />
      ) : links.data && links.data.length === 0 ? (
        <EmptyState
          icon={<Link2 />}
          title="No application links yet"
          description="Create one to put in an Instagram ad, a post or a text message."
          action={
            <Button icon={<Plus />} onClick={() => setCreating(true)}>
              New link
            </Button>
          }
        />
      ) : (
        <ul className="flex flex-col divide-y divide-line-soft" aria-busy={links.isPending}>
          {(links.data ?? []).map((link) => (
            <li key={link.id} className="flex flex-col gap-2 py-3 first:pt-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{link.name}</span>
                <Badge tone={link.active ? 'success' : 'neutral'}>
                  {link.active ? 'Active' : 'Off'}
                </Badge>
                {link.campaignName ? (
                  <span className="text-xs text-muted">Campaign: {link.campaignName}</span>
                ) : null}
              </div>
              <code className="break-all rounded-md bg-surface-muted px-2 py-1 text-sm text-secondary">
                {applyUrl(link.slug)}
              </code>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs text-muted">
                  {link.applicationCount === 0
                    ? 'No applications yet'
                    : `${link.applicationCount} application${link.applicationCount === 1 ? '' : 's'}, last ${formatRelative(link.lastApplicationAt ?? link.createdAt)}`}
                </span>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Copy />}
                    onClick={() => void copy(link)}
                  >
                    Copy link
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<ExternalLink />}
                    onClick={() => window.open(applyUrl(link.slug), '_blank', 'noopener')}
                    disabled={!link.active}
                  >
                    Open
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={toggle.isPending && toggle.variables?.id === link.id}
                    onClick={() =>
                      void toggle
                        .mutateAsync(link)
                        .then(() =>
                          toast({
                            title: link.active ? 'Link switched off' : 'Link switched on',
                            tone: 'success',
                          }),
                        )
                        .catch((e: unknown) =>
                          toast({
                            title: e instanceof ApiError ? e.message : 'Not changed',
                            tone: 'danger',
                          }),
                        )
                    }
                  >
                    {link.active ? 'Switch off' : 'Switch on'}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

function CreateLinkForm({ onDone }: { onDone: () => void }) {
  const { toast } = useToast();
  const campaigns = useCampaigns();
  const mutation = useHiringMutation(hiringApi.createApplyLink);
  const [form, setForm] = useState({
    name: '',
    slug: '',
    shortName: '',
    source: 'social',
    campaignId: '',
    logoUrl: '',
    consentText: '',
    privacyPolicyUrl: '',
  });
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const slugify = (v: string) =>
    v
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, 48);

  const submit = async () => {
    setError(null);
    setFieldErrors({});
    try {
      const link = await mutation.mutateAsync({
        ...form,
        slug: form.slug.replace(/-+$/, ''),
        source: form.source as ApplyLink['source'],
        campaignId: form.campaignId || null,
        logoUrl: form.logoUrl || null,
        shortName: form.shortName.trim() || null,
      });
      try {
        await navigator.clipboard.writeText(applyUrl(link.slug));
        toast({ title: 'Link created and copied', tone: 'success' });
      } catch {
        toast({ title: 'Link created', tone: 'success' });
      }
      onDone();
    } catch (caught) {
      if (caught instanceof ApiError) {
        const errors = (caught.problem as { errors?: { path: string; message: string }[] }).errors;
        if (errors?.length) {
          setFieldErrors(Object.fromEntries(errors.map((e) => [e.path, e.message])));
          setError('Some fields need a second look.');
        } else setError(caught.message);
      } else setError('The link could not be created');
    }
  };

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert tone="danger" title="Not created">
          {error}
        </Alert>
      ) : null}
      <FormField label="Name" required error={fieldErrors.name} description="Only HR sees this.">
        <Input
          value={form.name}
          placeholder="Instagram — fall drivers"
          onChange={(e) => {
            const name = e.target.value;
            setForm((f) => ({
              ...f,
              name,
              slug: f.slug === '' || f.slug === slugify(f.name) ? slugify(name) : f.slug,
            }));
          }}
        />
      </FormField>
      <FormField
        label="Link address"
        required
        error={fieldErrors.slug}
        description={`${window.location.origin}/apply/${form.slug || '…'}`}
      >
        <Input
          value={form.slug}
          onChange={(e) => setForm({ ...form, slug: slugify(e.target.value) })}
        />
      </FormField>
      <FormField
        label="Short name"
        error={fieldErrors.shortName}
        description="Shown as 'Drive with …' on the page. Up to 12 characters."
      >
        <Input
          value={form.shortName}
          maxLength={12}
          placeholder="e.g. NWF"
          onChange={(e) => setForm({ ...form, shortName: e.target.value })}
        />
      </FormField>
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Record leads as" required>
          <Select
            options={APPLICANT_SOURCES.map((v) => ({ value: v, label: v.replace(/_/g, ' ') }))}
            value={form.source}
            onValueChange={(v) => setForm({ ...form, source: v })}
          />
        </FormField>
        <FormField label="Campaign" error={fieldErrors.campaignId}>
          <Select
            options={[
              { value: '', label: 'None' },
              ...(campaigns.data ?? [])
                .filter((c) => c.active)
                .map((c) => ({ value: c.id, label: c.name })),
            ]}
            value={form.campaignId}
            onValueChange={(v) => setForm({ ...form, campaignId: v })}
          />
        </FormField>
      </div>
      <FormField
        label="Consent wording"
        required
        error={fieldErrors.consentText}
        description="Paste the wording your company has approved. Drivers must tick it to apply; NeWay does not supply legal text."
      >
        <Textarea
          rows={3}
          value={form.consentText}
          onChange={(e) => setForm({ ...form, consentText: e.target.value })}
        />
      </FormField>
      <FormField
        label="Privacy policy address"
        required
        error={fieldErrors.privacyPolicyUrl}
        description="Shown next to the consent as a link. Must start with https://"
      >
        <Input
          type="url"
          value={form.privacyPolicyUrl}
          onChange={(e) => setForm({ ...form, privacyPolicyUrl: e.target.value })}
        />
      </FormField>
      <FormField
        label="Logo address"
        error={fieldErrors.logoUrl}
        description="Optional. A small square image at an https:// address or a path on this site, such as /brand/nwf-logo.png; without one, the company's initials are shown."
      >
        <Input
          value={form.logoUrl}
          onChange={(e) => setForm({ ...form, logoUrl: e.target.value })}
        />
      </FormField>
      <div className="flex justify-end gap-2 border-t border-line-soft pt-3">
        <Button variant="ghost" onClick={onDone}>
          Back
        </Button>
        <Button onClick={() => void submit()} loading={mutation.isPending}>
          Create link
        </Button>
      </div>
    </div>
  );
}
