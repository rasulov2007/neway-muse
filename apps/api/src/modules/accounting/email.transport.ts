import { Injectable } from '@nestjs/common';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer, { type Transporter } from 'nodemailer';
import { Resend } from 'resend';
import { env } from '../../config/env';

export type EmailKind = 'resend' | 'smtp' | 'graph' | 'file' | 'none';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments: Array<{ filename: string; content: Buffer }>;
  /** "Company <recruiting@mail.neway.example.com>" — Resend only; other transports send as SMTP_FROM. */
  from?: string;
  replyTo?: string | null;
  /** Resend idempotency key: a retried send never delivers twice. */
  idempotencyKey?: string;
}

/** A temporary failure (rate limit, provider 5xx, network) — the caller may retry. */
export class TransientEmailError extends Error {}

/** Server-side SMTP options from SMTP_URL: smtps:// is TLS from the start; anything else must STARTTLS. */
function smtpOptions(url: string) {
  const u = new URL(url);
  const secure = u.protocol === 'smtps:';
  return {
    host: u.hostname,
    port: Number(u.port || (secure ? 465 : 587)),
    secure,
    // Port 587 (Microsoft 365 smtp.office365.com, Google smtp.gmail.com): refuse to send in the clear.
    requireTLS: !secure,
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : undefined,
  };
}

/**
 * The one email transport (section 6). Four kinds, chosen on the server (secrets never reach the
 * browser or a log):
 *   - `graph`: Microsoft 365 through Microsoft Graph `sendMail` with an app registration (client
 *     credentials, Mail.Send) — the company's mail is on Microsoft 365, and Exchange Online is
 *     retiring Basic-auth SMTP;
 *   - `smtp`: SMTP_URL (e.g. smtp://user:pass@smtp.office365.com:587, STARTTLS required);
 *   - `file`: each message as an .eml (+ .html) under the storage outbox, QA only;
 *   - `none`: nothing is sent, and the reason says what is missing.
 * A delivery is "sent" only when the transport accepted the message — accepted is not delivered.
 */
@Injectable()
export class EmailTransport {
  private transporter: Transporter | null = null;
  private graphToken: { value: string; until: number } | null = null;

  private resend: Resend | null = null;

  describe(): { kind: EmailKind; from: string | null; detail: string } {
    const from = env.SMTP_FROM ?? null;
    if (env.EMAIL_TRANSPORT === 'resend' || (env.EMAIL_TRANSPORT === undefined && env.RESEND_EMAIL_API)) {
      if (!env.RESEND_EMAIL_API) return { kind: 'none', from: null, detail: 'Resend is chosen but RESEND_EMAIL_API is not set on the server' };
      return { kind: 'resend', from: `NeWay <notifications@${env.EMAIL_FROM_DOMAIN}>`, detail: `Resend (${env.EMAIL_FROM_DOMAIN})` };
    }
    if (env.EMAIL_TRANSPORT === 'graph') {
      const missing = [
        ['GRAPH_TENANT_ID', env.GRAPH_TENANT_ID],
        ['GRAPH_CLIENT_ID', env.GRAPH_CLIENT_ID],
        ['GRAPH_CLIENT_SECRET', env.GRAPH_CLIENT_SECRET],
        ['SMTP_FROM (the sending mailbox)', env.SMTP_FROM],
      ]
        .filter(([, v]) => !v)
        .map(([k]) => k);
      return missing.length === 0
        ? { kind: 'graph', from, detail: 'Microsoft 365 (Graph sendMail)' }
        : { kind: 'none', from: null, detail: `Microsoft 365 is chosen but not complete: set ${missing.join(', ')} on the server` };
    }
    if (env.EMAIL_TRANSPORT === 'smtp') {
      if (!env.SMTP_URL || !env.SMTP_FROM) return { kind: 'none', from: null, detail: 'SMTP is chosen but SMTP_URL or SMTP_FROM is missing on the server' };
      return { kind: 'smtp', from, detail: `SMTP ${new URL(env.SMTP_URL).hostname}` };
    }
    if (env.EMAIL_TRANSPORT === 'file') return { kind: 'file', from: from ?? 'qa@localhost', detail: `Sandbox: messages written to ${join(env.STORAGE_LOCAL_PATH, 'outbox')}` };
    return { kind: 'none', from: null, detail: 'no email transport on the server (EMAIL_TRANSPORT=graph for Microsoft 365, or smtp with SMTP_URL and SMTP_FROM)' };
  }

  async send(message: EmailMessage): Promise<{ info: string; messageId: string | null }> {
    const t = this.describe();
    if (t.kind === 'none') throw new Error(t.detail);
    if (t.kind === 'resend') return this.sendResend(message);
    if (t.kind === 'file') {
      const dir = join(env.STORAGE_LOCAL_PATH, 'outbox');
      mkdirSync(dir, { recursive: true });
      const name = `${Date.now()}-${message.to.replace(/[^a-z0-9@.]/gi, '_')}.eml`;
      const eml = `From: ${message.from ?? t.from}\r\n${message.replyTo ? `Reply-To: ${message.replyTo}\r\n` : ''}To: ${message.to}\r\nSubject: ${message.subject}\r\nX-Attachments: ${message.attachments.map((a) => `${a.filename} (${a.content.length} bytes)`).join(', ')}\r\n\r\n${message.text}\r\n`;
      writeFileSync(join(dir, name), eml);
      // The HTML part beside it, so QA can open exactly what a phone would show.
      if (message.html) writeFileSync(join(dir, `${name.slice(0, -4)}.html`), message.html);
      return { info: `Written to outbox/${name} (sandbox transport; no mail left the server)`, messageId: name };
    }
    if (t.kind === 'graph') return this.sendGraph(t.from as string, message);
    this.transporter ??= nodemailer.createTransport(smtpOptions(env.SMTP_URL!));
    const result = await this.transporter.sendMail({ from: t.from ?? undefined, to: message.to, subject: message.subject, text: message.text, html: message.html, attachments: message.attachments });
    return { info: `Accepted by SMTP: ${result.messageId}`, messageId: result.messageId ?? null };
  }

  private async token(): Promise<string> {
    if (this.graphToken && this.graphToken.until > Date.now() + 60_000) return this.graphToken.value;
    const res = await fetch(`${env.GRAPH_LOGIN_BASE.replace(/\/+$/, '')}/${encodeURIComponent(env.GRAPH_TENANT_ID!)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GRAPH_CLIENT_ID!,
        client_secret: env.GRAPH_CLIENT_SECRET!,
        scope: 'https://graph.microsoft.com/.default',
        grant_type: 'client_credentials',
      }).toString(),
      signal: AbortSignal.timeout(15_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
    if (!res.ok || !body.access_token) throw new Error(`Microsoft sign-in refused: ${body.error ?? res.status}${body.error_description ? ` — ${body.error_description.split('\r\n')[0]}` : ''}`);
    this.graphToken = { value: body.access_token, until: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }

  private async sendGraph(from: string, message: { to: string; subject: string; text: string; html?: string; attachments: Array<{ filename: string; content: Buffer }> }) {
    const res = await fetch(`${env.GRAPH_API_BASE.replace(/\/+$/, '')}/v1.0/users/${encodeURIComponent(from)}/sendMail`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await this.token()}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        message: {
          subject: message.subject,
          body: message.html ? { contentType: 'HTML', content: message.html } : { contentType: 'Text', content: message.text },
          toRecipients: [{ emailAddress: { address: message.to } }],
          attachments: message.attachments.map((a) => ({ '@odata.type': '#microsoft.graph.fileAttachment', name: a.filename, contentBytes: a.content.toString('base64') })),
        },
        saveToSentItems: true,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status !== 202) {
      const body = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
      throw new Error(`Microsoft 365 refused the message: ${body.error?.code ?? res.status}${body.error?.message ? ` — ${body.error.message}` : ''}`);
    }
    return { info: 'Accepted by Microsoft 365', messageId: res.headers.get('request-id') };
  }

  private async sendResend(message: EmailMessage): Promise<{ info: string; messageId: string | null }> {
    this.resend ??= new Resend(env.RESEND_EMAIL_API);
    const { data, error } = await this.resend.emails.send(
      {
        from: message.from ?? `NeWay <notifications@${env.EMAIL_FROM_DOMAIN}>`,
        to: [message.to],
        subject: message.subject,
        text: message.text,
        ...(message.html ? { html: message.html } : {}),
        ...(message.replyTo ? { replyTo: message.replyTo } : {}),
        attachments: message.attachments.map((a) => ({ filename: a.filename, content: a.content })),
      },
      message.idempotencyKey ? { idempotencyKey: message.idempotencyKey } : undefined,
    );
    if (error || !data) {
      const name = (error as { name?: string; statusCode?: number } | null)?.name ?? '';
      const code = (error as { statusCode?: number } | null)?.statusCode ?? 0;
      const detail = `Resend refused the message: ${name || code || 'error'}${error?.message ? ` — ${error.message}` : ''}`;
      // 429 / 5xx / network: worth another try. 4xx (bad address, unverified domain): not.
      if (code === 429 || code >= 500 || name === 'rate_limit_exceeded' || name === 'application_error' || name === 'internal_server_error' || !code) throw new TransientEmailError(detail);
      throw new Error(detail);
    }
    return { info: `Accepted by Resend: ${data.id}`, messageId: data.id };
  }
}
