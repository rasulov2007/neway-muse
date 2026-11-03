import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { useState } from 'react';
import type { PmShop } from '@neway/shared';
import { Button, Input, useToast } from '@/design-system';
import { apiGet, apiPatch } from '@/lib/api-client';

const SHOPS_KEY = ['pm', 'shops'] as const;

/**
 * Shops named by their address (owner, 2026-10-19). The oil-change import only had where the
 * truck was serviced, so 65 shops carry an address for a name and every page showed it. Each row
 * takes the shop's real name; saving names the shop and the work orders that point at it.
 */
export function NameShopsPanel() {
  const shops = useQuery({
    queryKey: SHOPS_KEY,
    queryFn: async () => {
      try {
        return await apiGet<PmShop[]>('/fleet/pm/shops');
      } catch {
        return [];
      }
    },
  });
  const unnamed = (shops.data ?? []).filter((s) => s.needsName);
  if (unnamed.length === 0) return null;
  return (
    <section aria-label="Shops to name" className="rounded-[10px] border border-nw-warning-border bg-nw-panel" data-testid="name-shops">
      <div className="border-b border-nw-border px-4 py-3">
        <h2 className="text-sm font-bold text-nw-text">
          {unnamed.length} shop{unnamed.length === 1 ? '' : 's'} named by their address
        </h2>
        <p className="text-xs text-nw-text-2">Type the shop's real name. The repairs and oil changes done there will show it too.</p>
      </div>
      <ul className="max-h-[420px] divide-y divide-nw-border overflow-y-auto">
        {unnamed.map((s) => (
          <ShopRow key={s.id} shop={s} />
        ))}
      </ul>
    </section>
  );
}

function ShopRow({ shop }: { shop: PmShop }) {
  const [name, setName] = useState('');
  const client = useQueryClient();
  const { toast } = useToast();
  const save = useMutation({
    mutationFn: () => apiPatch<PmShop[]>(`/fleet/pm/shops/${encodeURIComponent(shop.id)}`, { name: name.trim(), version: shop.version }),
    onSuccess: async (list) => {
      client.setQueryData(SHOPS_KEY, list);
      await client.invalidateQueries({ queryKey: ['work-orders'] });
      toast({ tone: 'success', title: `${name.trim()} saved` });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  const where = [shop.addressLine && shop.addressLine !== shop.name ? shop.addressLine : null, shop.city, shop.state].filter(Boolean).join(', ');
  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-2.5">
      <span className="flex min-w-[260px] flex-1 items-start gap-2 text-sm">
        <MapPin className="mt-0.5 size-4 shrink-0 text-nw-text-3" aria-hidden />
        <span className="min-w-0">
          <span className="block truncate text-nw-text">{shop.name}</span>
          {where && where !== shop.name ? <span className="block truncate text-xs text-nw-text-3">{where}</span> : null}
          <span className="block text-xs text-nw-text-3">{shop.visits} oil change{shop.visits === 1 ? '' : 's'} recorded</span>
        </span>
      </span>
      <Input
        size="sm"
        aria-label={`Name for ${shop.name}`}
        placeholder="Shop name, e.g. Love's Truck Care"
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && name.trim().length >= 2) save.mutate();
        }}
        className="w-72"
      />
      <Button size="sm" variant="primary" disabled={name.trim().length < 2 || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>
        Save
      </Button>
    </li>
  );
}
