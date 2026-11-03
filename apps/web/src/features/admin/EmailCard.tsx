import { useQuery } from '@tanstack/react-query';
import { Mail } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, Input, useToast } from '@/design-system';
import { apiGet, apiPost } from '@/lib/api-client';

interface EmailStatus {
  kind: 'smtp' | 'graph' | 'file' | 'none';
  from: string | null;
  detail: string;
  ready: boolean;
}

const KIND: Record<EmailStatus['kind'], string> = {
  graph: 'Microsoft 365 (Graph)',
  smtp: 'SMTP',
  file: 'Sandbox outbox (QA)',
  none: 'Not set up',
};

/**
 * Email (Settings › Integrations): which transport the server sends with — its secrets are server
 * settings and never shown — and a test message. "Accepted" is the mail server's word, not delivery.
 */
export function EmailCard({ canManage }: { canManage: boolean }) {
  const { toast } = useToast();
  const status = useQuery({ queryKey: ['admin', 'email'], queryFn: () => apiGet<EmailStatus>('/admin/email'), enabled: canManage });
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; detail: string } | null>(null);
  if (!canManage) return null;
  const s = status.data;
  const test = async () => {
    setBusy(true);
    try {
      const r = await apiPost<{ ok: boolean; detail: string }>('/admin/email/test', { to: to.trim() });
      setResult(r);
    } catch (error) {
      toast({ tone: 'danger', title: 'Test not sent', description: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card padding="md" title="Email" data-testid="email-card">
      {status.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : !s ? (
        <p className="text-sm text-danger-text">The email status could not be loaded.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm text-ink">
            <Mail aria-hidden className="mr-1.5 inline size-4 text-muted" />
            {KIND[s.kind]}
            {s.from ? ` · sends as ${s.from}` : ''}
          </p>
          <p className="text-xs text-muted">
            {s.kind === 'none'
              ? `${s.detail}. The company mail is Microsoft 365: an Entra app with the Mail.Send permission (GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET) and the sending mailbox (SMTP_FROM) are set on the server.`
              : s.detail}
          </p>
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-72">
              <Input aria-label="Send a test to" placeholder="you@northwind-freight.example" value={to} onChange={(e) => setTo(e.target.value)} />
            </div>
            <Button variant="outline" size="sm" disabled={!s.ready || !/^\S+@\S+\.\S+$/.test(to.trim())} loading={busy} onClick={() => void test()} data-testid="email-test">
              Send a test email
            </Button>
          </div>
          {result ? <Alert tone={result.ok ? 'success' : 'danger'} title={result.ok ? 'Accepted by the mail service' : 'Not sent'} description={result.detail} /> : null}
        </div>
      )}
    </Card>
  );
}
