import type { JourneyLinkKind } from '@neway/shared';

/**
 * The words the TMS sends with a candidate's private link: one SMS and one email per link kind.
 *
 * Email clients ignore stylesheets and CSS variables, so the email carries its colours inline.
 * They are the Porcelain light tokens (design/porcelain/porcelain-theme.css), copied by value —
 * like the hosted application page, an email is outside the app's token pipeline. Light only: a
 * mail client decides its own dark mode. Single column, 16px text, a full-width button and the
 * plain link under it, so it reads on a phone and still works where buttons are stripped.
 */
const PORCELAIN = {
  bg: '#F3F5F4', // --nw-bg
  panel: '#FFFFFF', // --nw-panel
  border: '#E2E7E5', // --nw-border
  text: '#16201F', // --nw-text
  text2: '#4B5856', // --nw-text-2
  text3: '#66736F', // --nw-text-3
  accent: '#0B7A74', // --nw-accent
  accentInk: '#075C57', // --nw-accent-ink
  accentTint: '#E0F1EF', // --nw-accent-tint
} as const;

const FONT = "Manrope, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

const escapeHtml = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const longDate = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'long', day: 'numeric', year: 'numeric' }).format(new Date(iso));

interface Copy {
  subject: string;
  heading: string;
  lead: string;
  steps: string[];
  button: string;
  sms: string;
}

function copyFor(kind: JourneyLinkKind, companyName: string): Copy {
  if (kind === 'consent') {
    return {
      subject: `${companyName}: please review and sign your driver consents`,
      heading: 'Review and sign your consents',
      lead: `To continue with your driver application at ${companyName}, please review and sign the background-check consents.`,
      steps: ['Read each disclosure (MVR and PSP)', 'Add a photo of the front of your CDL', 'Sign with your name or your finger'],
      button: 'Review and sign',
      sms: `${companyName}: please review and sign your driver consents here:`,
    };
  }
  return {
    subject: `${companyName}: complete your driver application`,
    heading: 'Complete your driver application',
    lead: `Thank you — Safety has reviewed your checks. Please complete your driver application at ${companyName}.`,
    steps: ['Your name and contact details are already filled in', 'Add your work history and licence details', 'Upload the back of your CDL and your medical card'],
    button: 'Open my application',
    sms: `${companyName}: please complete your driver application here:`,
  };
}

export interface LinkMessage {
  subject: string;
  text: string;
  html: string;
  sms: string;
}

export function linkMessage(input: { kind: JourneyLinkKind; companyName: string; firstName: string; url: string; expiresAt: string }): LinkMessage {
  const c = copyFor(input.kind, input.companyName);
  const until = longDate(input.expiresAt);
  const hello = input.firstName ? `Hello ${input.firstName},` : 'Hello,';
  const text = [
    hello,
    '',
    c.lead,
    '',
    ...c.steps.map((s) => `- ${s}`),
    '',
    input.url,
    '',
    `This link is personal to you and works until ${until}. Please do not forward it.`,
    '',
    `${input.companyName} recruiting`,
  ].join('\n');
  // An SMS stays short: one sentence, the link, the expiry. No STOP footer is added here: Twilio
  // Messaging Services add the carrier-required opt-out text where the campaign needs it.
  const sms = `${c.sms} ${input.url} (personal link, works until ${until})`;
  const P = PORCELAIN;
  const e = escapeHtml;
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${e(c.subject)}</title>
</head>
<body style="margin:0;padding:0;background:${P.bg};">
<div style="display:none;max-height:0;overflow:hidden;">${e(c.lead)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${P.bg};">
<tr><td align="center" style="padding:24px 16px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
<tr><td style="padding:0 4px 12px;font-family:${FONT};font-size:14px;font-weight:700;color:${P.accentInk};">${e(input.companyName)}</td></tr>
<tr><td style="background:${P.panel};border:1px solid ${P.border};border-radius:10px;padding:24px 20px;font-family:${FONT};">
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.3;font-weight:700;color:${P.text};">${e(c.heading)}</h1>
<p style="margin:0 0 12px;font-size:16px;line-height:1.5;color:${P.text};">${e(hello)}</p>
<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:${P.text2};">${e(c.lead)}</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 20px;background:${P.accentTint};border-radius:8px;">
${c.steps.map((s, i) => `<tr><td style="padding:${i === 0 ? 12 : 4}px 14px ${i === c.steps.length - 1 ? 12 : 4}px;font-size:15px;line-height:1.45;color:${P.text};">${i + 1}. ${e(s)}</td></tr>`).join('\n')}
</table>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="border-radius:8px;background:${P.accent};">
<a href="${e(input.url)}" style="display:block;padding:14px 20px;font-family:${FONT};font-size:16px;font-weight:700;color:${P.panel};text-decoration:none;border-radius:8px;">${e(c.button)}</a>
</td></tr></table>
<p style="margin:16px 0 4px;font-size:13px;line-height:1.5;color:${P.text3};">If the button does not work, open this link:</p>
<p style="margin:0 0 16px;font-size:13px;line-height:1.5;word-break:break-all;"><a href="${e(input.url)}" style="color:${P.accentInk};">${e(input.url)}</a></p>
<p style="margin:0;font-size:13px;line-height:1.5;color:${P.text3};">This link is personal to you and works until ${e(until)}. Please do not forward it.</p>
</td></tr>
<tr><td style="padding:12px 4px 0;font-family:${FONT};font-size:12px;line-height:1.5;color:${P.text3};">${e(input.companyName)} recruiting · You received this because you applied to drive with us.</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;
  return { subject: c.subject, text, html, sms };
}
