import { Injectable, Logger } from '@nestjs/common';
import { LEAD_SOURCE_LABELS, type ApplicationAnswers } from '@neway/shared';
import { env } from '../../config/env';

const TIMEOUT_MS = 10_000;

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Posts each online application to the recruiting Telegram group (owner, 2026-10-07).
 *
 * The lead is already saved when this runs; a failure here is logged by its status alone (never
 * the driver's details) and the application stands. The token and chat id live in the server's
 * .env; without both, nothing is sent.
 */
@Injectable()
export class LeadTelegramNotifier {
  private readonly logger = new Logger(LeadTelegramNotifier.name);

  get enabled(): boolean {
    return Boolean(env.HIRING_TELEGRAM_BOT_TOKEN && env.HIRING_TELEGRAM_CHAT_ID);
  }

  text(input: {
    leadNumber: string;
    leadId: string;
    answers: ApplicationAnswers;
    source: string;
    again: boolean;
    /** Who has the lead: the recruiter whose turn it was, or who already had it. */
    recruiterName?: string | null;
  }): string {
    const a = input.answers;
    // The Recruiting page itself (owner, 2026-10-07): short, and it opens after the login.
    const link = `${env.DR_TMS_BASE_URL.replace(/\/$/, '')}/hr/recruiting`;
    return [
      input.again
        ? `🔁 <b>Applied again · ${escapeHtml(input.leadNumber)}</b>`
        : `🆕 <b>New lead · ${escapeHtml(input.leadNumber)}</b>`,
      `Name: ${escapeHtml(a.fullName)}`,
      `Phone: ${escapeHtml(a.phone)}`,
      `CDL experience: ${escapeHtml(a.experience)}`,
      `Looking for: ${escapeHtml(a.position)}`,
      `Source: ${escapeHtml(LEAD_SOURCE_LABELS[input.source] ?? input.source)}`,
      `Recruiter: ${input.recruiterName ? escapeHtml(input.recruiterName) : 'Unassigned'}`,
      `<a href="${link}">Open in TMS</a> — red until somebody marks it contacted.`,
    ].join('\n');
  }

  async send(text: string): Promise<boolean> {
    if (!this.enabled) return false;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${env.HIRING_TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.HIRING_TELEGRAM_CHAT_ID,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        },
      );
      if (!res.ok) this.logger.warn(`lead telegram: sendMessage answered ${res.status}`);
      return res.ok;
    } catch (error) {
      this.logger.warn(`lead telegram: not sent (${error instanceof Error ? error.name : 'error'})`);
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
