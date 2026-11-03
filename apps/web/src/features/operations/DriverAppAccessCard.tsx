import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Smartphone } from 'lucide-react';
import type { DriverAppAccess, GiveAppAccessResponse } from '@neway/shared';
import { Alert, Badge, Button, Card, Input, Textarea, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet, apiPost } from '@/lib/api-client';
import { formatDateTime } from '@/lib/format';

const STATE: Record<DriverAppAccess['state'], { word: string; tone: 'success' | 'warning' | 'neutral' | 'danger' }> = {
  none: { word: 'No access', tone: 'neutral' },
  invited: { word: 'Not signed in yet', tone: 'warning' },
  active: { word: 'Active', tone: 'success' },
  revoked: { word: 'Revoked', tone: 'danger' },
};

/**
 * Driver app access (mobile, 2026-10-27): give the driver a login to the NeWay driver app, see
 * whether they have signed in, revoke it. The temporary password is shown here once, right after
 * Give access, and never again.
 */
export function DriverAppAccessCard({ driverId, driverName }: { driverId: string; driverName: string }) {
  const account = useAccount();
  const canSee = account ? account.permissions.includes('drivers.view') || account.permissions.includes('drivers.edit') : false;
  const canEdit = account?.permissions.includes('drivers.edit') ?? false;
  const { toast } = useToast();
  const client = useQueryClient();
  const key = ['drivers', driverId, 'app-access'];
  const access = useQuery({ queryKey: key, queryFn: () => apiGet<DriverAppAccess>(`/drivers/${encodeURIComponent(driverId)}/app-access`), enabled: canSee });
  const [login, setLogin] = useState('');
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const [issued, setIssued] = useState<string | null>(null);

  const give = useMutation({
    mutationFn: () => apiPost<GiveAppAccessResponse>(`/drivers/${encodeURIComponent(driverId)}/app-access`, login.trim() ? { login: login.trim() } : {}),
    onSuccess: async (res) => {
      setIssued(res.temporaryPassword);
      setLogin('');
      await client.invalidateQueries({ queryKey: key });
      toast({ tone: 'success', title: `${driverName} can sign in to the driver app` });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Access not given', description: e instanceof Error ? e.message : undefined }),
  });
  const revoke = useMutation({
    mutationFn: () => apiPost<DriverAppAccess>(`/drivers/${encodeURIComponent(driverId)}/app-access/revoke`, { reason: reason.trim() }),
    onSuccess: async () => {
      setRevoking(false);
      setReason('');
      setIssued(null);
      await client.invalidateQueries({ queryKey: key });
      toast({ tone: 'success', title: 'Driver app access revoked', description: 'Every session on the phone has ended.' });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not revoked', description: e instanceof Error ? e.message : undefined }),
  });

  if (!canSee) return null;
  const data = access.data;
  const state = data ? STATE[data.state] : null;

  return (
    <Card
      padding="md"
      title={
        <span className="flex items-center gap-2">
          <Smartphone className="size-4 text-primary" aria-hidden />
          App access
        </span>
      }
    >
      {access.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : access.isError || !data || !state ? (
        <p className="text-sm text-danger-text">App access could not be loaded.</p>
      ) : (
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={state.tone} size="sm">{state.word}</Badge>
            {data.login ? (
              <span className="text-muted">
                Signs in as <span className="font-medium text-ink">{data.loginHint ?? data.login}</span>
                {data.lastSignInAt ? ` · last sign-in ${formatDateTime(data.lastSignInAt)}` : ''}
                {data.devices ? ` · ${data.devices} phone${data.devices === 1 ? '' : 's'} for notifications` : ''}
              </span>
            ) : (
              <span className="text-muted">The driver app shows this driver their own loads, paperwork and PTI only.</span>
            )}
          </div>

          {issued ? (
            <Alert
              tone="info"
              title="Temporary password - shown once"
              description={
                <span className="flex flex-wrap items-center gap-2">
                  <code className="rounded bg-surface-muted px-1.5 py-0.5 font-mono text-ink">{issued}</code>
                  <Button size="sm" variant="secondary" icon={<Copy />} onClick={() => void navigator.clipboard?.writeText(issued)}>
                    Copy
                  </Button>
                  <span className="text-muted">Give it to the driver; they choose their own at first sign-in.</span>
                </span>
              }
            />
          ) : null}

          {canEdit && (data.state === 'none' || data.state === 'revoked') ? (
            <div className="flex flex-wrap items-end gap-2">
              {data.state === 'none' ? (
                <Input
                  aria-label="Login (email or phone)"
                  placeholder="Email or phone (blank = the one on file)"
                  value={login}
                  onChange={(e) => setLogin(e.target.value)}
                  className="max-w-72"
                />
              ) : null}
              <Button variant="primary" size="sm" loading={give.isPending} onClick={() => give.mutate()}>
                Give access
              </Button>
            </div>
          ) : null}

          {canEdit && (data.state === 'active' || data.state === 'invited') && !revoking ? (
            <div>
              <Button variant="secondary" size="sm" onClick={() => setRevoking(true)}>
                Revoke
              </Button>
            </div>
          ) : null}
          {revoking ? (
            <div className="flex flex-col gap-2">
              <Textarea rows={2} aria-label="Why access is removed" placeholder="Why access is removed" value={reason} onChange={(e) => setReason(e.target.value)} />
              <div className="flex gap-2">
                <Button variant="primary" size="sm" disabled={reason.trim().length < 3} loading={revoke.isPending} onClick={() => revoke.mutate()}>
                  Revoke access
                </Button>
                <Button variant="secondary" size="sm" onClick={() => { setRevoking(false); setReason(''); }}>
                  Cancel
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      )}
    </Card>
  );
}
