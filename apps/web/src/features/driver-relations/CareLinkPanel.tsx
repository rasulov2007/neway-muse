import { Link2 } from 'lucide-react';
import { useState } from 'react';
import { Badge, Button, Input, Modal, useToast } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { useCanManageLinks, useCareLinks, useCreateCareLink, useUpdateCareLink } from './api';

/** The public address of a Driver Care link on this site. */
function careUrl(slug: string): string {
  return `${window.location.origin}/care/${slug}`;
}

/**
 * The public NORTHWIND FREIGHT Driver Care page is reached through a link like /care/nwf. The link
 * decides the company on the server. Managers create and switch links off here; everybody who
 * can see Driver Relations can copy the address.
 */
export function CareLinkButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" icon={<Link2 aria-hidden />} onClick={() => setOpen(true)}>
        Driver Care link
      </Button>
      {open ? <CareLinkModal onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CareLinkModal({ onClose }: { onClose: () => void }) {
  const links = useCareLinks();
  const canManage = useCanManageLinks();
  const create = useCreateCareLink();
  const update = useUpdateCareLink();
  const { toast } = useToast();
  const [name, setName] = useState('NORTHWIND FREIGHT Driver Care');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);

  const copy = async (address: string) => {
    try {
      await navigator.clipboard.writeText(address);
      toast({ title: 'Link copied', tone: 'success' });
    } catch {
      toast({ title: `Copy this address: ${address}`, tone: 'info' });
    }
  };

  const add = async () => {
    if (create.isPending) return;
    setError(null);
    try {
      await create.mutateAsync({ name, slug });
      setSlug('');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Not saved. Try again.');
    }
  };

  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} title="Driver Care links" size="md">
      <div className="flex flex-col gap-4 text-sm">
        {links.isPending ? (
          <p className="text-xs text-nw-text-3">Loading…</p>
        ) : links.isError ? (
          <p className="text-xs text-nw-urgent-text">The links could not be loaded.</p>
        ) : (links.data ?? []).length === 0 ? (
          <p className="text-xs text-nw-text-3">No Driver Care link yet. Drivers cannot send requests until one exists.</p>
        ) : (
          <ul className="flex flex-col gap-2">
            {(links.data ?? []).map((l) => (
              <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-nw-border px-3 py-2">
                <span className="min-w-0">
                  <span className="block font-semibold text-nw-text">{l.name}</span>
                  <span className="block truncate text-2xs text-nw-text-3">/care/{l.slug} · {l.requestCount} submissions</span>
                </span>
                <span className="flex items-center gap-2">
                  <Badge tone={l.active ? 'success' : 'neutral'} dot size="sm">
                    {l.active ? 'Active' : 'Off'}
                  </Badge>
                  <Button size="sm" variant="secondary" onClick={() => void copy(careUrl(l.slug))}>
                    Copy
                  </Button>
                  {canManage ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={update.isPending}
                      onClick={() => void update.mutateAsync({ id: l.id, body: { active: !l.active } }).catch(() => undefined)}
                    >
                      {l.active ? 'Switch off' : 'Switch on'}
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
        {canManage ? (
          <div className="flex flex-col gap-2 border-t border-nw-border pt-3">
            <h3 className="text-xs font-semibold text-nw-text-2">New link</h3>
            <Input aria-label="Link name" value={name} onChange={(e) => setName(e.target.value)} />
            <Input
              aria-label="Address"
              prefix={<span className="text-xs text-nw-text-3">/care/</span>}
              placeholder="nwf"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
            />
            {error ? (
              <p role="alert" className="text-xs text-nw-urgent-text">
                {error}
              </p>
            ) : null}
            <div>
              <Button size="sm" variant="primary" onClick={() => void add()} loading={create.isPending} disabled={create.isPending || !slug.trim()}>
                Create link
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}
