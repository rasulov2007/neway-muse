import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, asc, eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { hiringLeads } from '../../database/schema/hiring';
import { employees } from '../../database/schema/people';
import { LeadTelegramNotifier } from './lead-telegram';

/**
 * Follow-up reminders for leads that were called and did not answer (owner, 2026-10-23).
 *
 * At 10:00, 13:00 and 17:00 Eastern every lead still in "Called · no answer" is posted to the
 * recruiting Telegram group, one message per lead. A lead that leaves the status stops being
 * posted, because each run reads the status as it is then. Only the company named by
 * HIRING_TELEGRAM_COMPANY_ID is read; test leads never are.
 */
const SLOT_HOURS = [10, 13, 17];
/** A slot still fires if the server was restarting at the top of the hour. */
const SLOT_WINDOW_MINUTES = 10;
const CHECK_MS = 60_000;
/** Telegram allows about 20 messages a minute into one group. */
const PACE_MS = 3_500;

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

@Injectable()
export class LeadFollowUpScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastSlot: string | null = null;

  constructor(
    private readonly database: DatabaseService,
    private readonly telegram: LeadTelegramNotifier,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(LeadFollowUpScheduler.name);
  }

  onModuleInit(): void {
    if (env.NODE_ENV === 'test' || !this.telegram.enabled || !env.HIRING_TELEGRAM_COMPANY_ID) return;
    this.timer = setInterval(() => void this.check(new Date()), CHECK_MS);
    this.timer.unref();
    this.logger.info(`Lead follow-ups at ${SLOT_HOURS.join(':00, ')}:00 Eastern`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async check(now: Date): Promise<void> {
    const slot = followUpSlot(now);
    if (!slot || slot === this.lastSlot) return;
    this.lastSlot = slot;
    await this.run();
  }

  /** One pass: every no-answer lead, one message each. Public so an operator can call it. */
  async run(): Promise<{ sent: number; leads: number }> {
    const companyId = env.HIRING_TELEGRAM_COMPANY_ID;
    if (this.running || !companyId) return { sent: 0, leads: 0 };
    this.running = true;
    let sent = 0;
    try {
      const leads = await this.database.db
        .select({
          id: hiringLeads.id,
          leadNumber: hiringLeads.leadNumber,
          firstName: hiringLeads.firstName,
          lastName: hiringLeads.lastName,
          phone: hiringLeads.phone,
          recruiterFirst: employees.firstName,
          recruiterLast: employees.lastName,
          recruiterPreferred: employees.preferredName,
        })
        .from(hiringLeads)
        .leftJoin(employees, eq(employees.id, hiringLeads.recruiterEmployeeId))
        .where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.status, 'no_answer'), eq(hiringLeads.isTest, false)))
        .orderBy(asc(hiringLeads.createdAt));
      for (const [i, lead] of leads.entries()) {
        if (i > 0) await new Promise((resolve) => setTimeout(resolve, PACE_MS));
        const recruiterName = lead.recruiterFirst ? `${lead.recruiterPreferred || lead.recruiterFirst} ${lead.recruiterLast ?? ''}`.trim() : null;
        if (await this.telegram.send(followUpText({ ...lead, recruiterName }))) sent += 1;
      }
      this.logger.info(`Lead follow-ups: ${sent} of ${leads.length} posted`);
      return { sent, leads: leads.length };
    } finally {
      this.running = false;
    }
  }
}

/** The slot this moment falls in ("2026-10-23 10"), or null outside the windows. Eastern time. */
export function followUpSlot(now: Date): string | null {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  if (!SLOT_HOURS.includes(hour) || minute >= SLOT_WINDOW_MINUTES) return null;
  return `${get('year')}-${get('month')}-${get('day')} ${hour}`;
}

/** The owner's format (2026-10-23): flag line, lead number, Name, Phone, Recruiter, and a short link to the lead. */
export function followUpText(lead: { id: string; leadNumber: string; firstName: string; lastName: string; phone: string; recruiterName?: string | null }): string {
  const link = `${env.DR_TMS_BASE_URL.replace(/\/$/, '')}/hr/recruiting/${encodeURIComponent(lead.id)}`;
  return [
    'FOLLOW UP 🟥🟥🟥🟥',
    escapeHtml(lead.leadNumber),
    `Name: ${escapeHtml(`${lead.firstName} ${lead.lastName}`.trim())}`,
    `Phone: ${escapeHtml(lead.phone)}`,
    `Recruiter: ${lead.recruiterName ? escapeHtml(lead.recruiterName) : 'Unassigned'}`,
    `<a href="${link}">Open in TMS</a>`,
  ].join('\n');
}
