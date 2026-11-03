/**
 * The driver-facing emails (owner brief 2026-10-27 §7). Plain wording, the company's own name, no
 * SSN, no date of birth, no personal data in any link. HTML is a simple single-column card that
 * reads on a phone; the text part says the same.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function card(company: string, body: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f1;font-family:Segoe UI,-apple-system,Roboto,Arial,sans-serif;color:#14231d">
<div style="max-width:560px;margin:0 auto;padding:24px 16px">
<div style="font-weight:800;letter-spacing:.14em;font-size:13px;text-transform:uppercase">${esc(company)}</div>
<div style="font-weight:700;letter-spacing:.3em;font-size:9px;color:#3b5a4a;text-transform:uppercase;margin:4px 0 18px">Driver application</div>
<div style="background:#fff;border:1px solid #e7e8e4;border-radius:14px;padding:22px 20px;font-size:15px;line-height:1.55">${body}</div>
<p style="font-size:12px;color:#5d6b66;margin:16px 4px 0">Sent by ${esc(company)} recruiting through NeWay. If you did not apply, you can ignore this email.</p>
</div></body></html>`;
}

function button(url: string, label: string): string {
  return `<p style="margin:22px 0"><a href="${esc(url)}" style="display:inline-block;background:#214a36;color:#fff;text-decoration:none;font-weight:700;padding:13px 22px;border-radius:8px">${esc(label)}</a></p>
<p style="font-size:12px;color:#5d6b66;word-break:break-all">Or open this link: ${esc(url)}</p>`;
}

function longDate(d: Date, zone: string): string {
  return d.toLocaleString('en-US', { timeZone: zone, month: 'long', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
}

export function applicationLinkEmail(p: { firstName: string; company: string; url: string; expiresAt: Date; zone: string }) {
  const hi = p.firstName ? `Hi ${p.firstName},` : 'Hello,';
  const until = longDate(p.expiresAt, p.zone);
  return {
    subject: `${p.company}: complete your DOT driver application`,
    text: `${hi}\n\nPlease complete your DOT driver application for ${p.company}:\n${p.url}\n\nWhen you open the link you will get a 6-digit code by email to confirm it is you.\nThe link works until ${until}. Your answers save as you go, on any device.\n\n${p.company} recruiting`,
    html: card(
      p.company,
      `<p style="margin:0 0 12px">${esc(hi)}</p><p style="margin:0 0 12px">Please complete your DOT driver application for <b>${esc(p.company)}</b>.</p>${button(p.url, 'Open my application')}<p style="margin:0 0 8px">When you open the link you will get a <b>6-digit code</b> by email to confirm it is you.</p><p style="margin:0;color:#5d6b66;font-size:13px">The link works until ${esc(until)}. Your answers save as you go, on any device.</p>`,
    ),
  };
}

export function codeEmail(p: { code: string; company: string; minutes: number }) {
  return {
    subject: `${p.code} is your ${p.company} application code`,
    text: `Your code for the ${p.company} driver application is ${p.code}.\nIt works once, for ${p.minutes} minutes. Do not share it with anyone.`,
    html: card(
      p.company,
      `<p style="margin:0 0 10px">Your code for the ${esc(p.company)} driver application:</p><p style="font-size:30px;font-weight:800;letter-spacing:.3em;margin:8px 0 14px">${esc(p.code)}</p><p style="margin:0;color:#5d6b66;font-size:13px">It works once, for ${p.minutes} minutes. Do not share it with anyone.</p>`,
    ),
  };
}

export function changesEmail(p: { firstName: string; company: string; url: string; message: string; sections: string[]; expiresAt: Date; zone: string }) {
  const hi = p.firstName ? `Hi ${p.firstName},` : 'Hello,';
  return {
    subject: `${p.company}: please update your driver application`,
    text: `${hi}\n\n${p.company} Safety reviewed your application and asks for changes:\n\n${p.message}\n\nSections: ${p.sections.join(', ')}\n\nOpen your application: ${p.url}\nYou will get a 6-digit code by email. Sign the changed sections again, then submit.\nThe link works until ${longDate(p.expiresAt, p.zone)}.\n\n${p.company} Safety`,
    html: card(
      p.company,
      `<p style="margin:0 0 12px">${esc(hi)}</p><p style="margin:0 0 10px">${esc(p.company)} Safety reviewed your application and asks for changes:</p><blockquote style="margin:0 0 12px;padding:10px 14px;background:#fbf3e4;border-radius:8px">${esc(p.message).replace(/\n/g, '<br>')}</blockquote><p style="margin:0 0 6px;font-size:13px">Sections: ${esc(p.sections.join(', '))}</p>${button(p.url, 'Update my application')}<p style="margin:0;color:#5d6b66;font-size:13px">You will get a 6-digit code by email. Sign the changed sections again, then submit.</p>`,
    ),
  };
}
