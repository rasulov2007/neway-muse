import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, asc, eq, lte, sql } from 'drizzle-orm';
import { DRIVER_RELATION_TOPIC_LABELS, type DriverRelationTopic } from '@neway/shared';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { driverRelationOutbox, driverRelationRequests } from '../../database/schema/driver-relations';
import { TelegramAdapter } from './telegram.adapter';

const BATCH = 10;
const MAX_ATTEMPTS = 6;
/** A notification older than this when it could first be sent is history, not news. */
const STALE_AFTER_MS = 24 * 60 * 60_000;
/** A claimed row is invisible to other workers for this long, in case this one dies mid-send. */
const LEASE_MS = 5 * 60_000;
const TICK_MS = 30_000;

/** 1, 2, 4, 8, 16 minutes, capped at an hour. */
export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** Math.max(0, attempts - 1), 60 * 60_000);
}

const EASTERN = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/**
 * The notification text. Generic on purpose: the request number, topic, the name and truck the
 * driver typed, when it arrived (Eastern) and a link to the TMS page, which asks for a login. Never
 * the driver's own words, a phone number, an amount or anything confidential.
 */
export function telegramText(input: {
  eventType: string;
  requestId: string;
  requestNumber: string;
  topic: string;
  submittedName: string;
  truck: string | null;
  at: Date;
  /** Confidential requests are announced without the driver's name or truck. */
  confidential?: boolean;
}): string {
  const topic = DRIVER_RELATION_TOPIC_LABELS[input.topic as DriverRelationTopic] ?? input.topic;
  const head =
    input.eventType === 'driver_message'
      ? `New driver message on ${input.requestNumber}`
      : `New Driver Relations request ${input.requestNumber}`;
  // Sent as HTML (owner, 2026-10-07): a short blue "Open in TMS", not a long address. What the
  // driver typed is escaped.
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const page = `${env.DR_TMS_BASE_URL.replace(/\/$/, '')}/driver-relations`;
  return [
    `<b>${esc(head)}</b>`,
    `Topic: ${esc(topic)}`,
    input.confidential ? 'Confidential: details in the TMS only.' : `Driver: ${esc(input.submittedName)}`,
    ...(input.confidential ? [] : [`Truck: ${esc(input.truck ?? 'not given')}`]),
    `Received: ${EASTERN.format(input.at)} ET`,
    `<a href="${page}">Open in TMS</a> — needs contact until a call is recorded in the TMS.`,
  ].join('\n');
}

/**
 * Sends what the outbox holds, after the request it announces is committed.
 *
 * Off unless the adapter is enabled: no timer starts and `tick()` returns without reading a row,
 * so a disabled adapter sends nothing and every row stays `pending`. When it is on: rows are
 * claimed with SKIP LOCKED and a lease (two API processes never take the same row), each is sent
 * once per (adapter, event) — the unique key is the dedup — and a failure is recorded with a
 * bounded backoff; after six attempts the row is `failed` and the request page says so. A send
 * never touches the request or its alert.
 */
@Injectable()
export class DriverRelationsOutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DriverRelationsOutboxWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly telegram: TelegramAdapter,
  ) {}

  onModuleInit(): void {
    if (!this.telegram.enabled()) {
      this.logger.log('Driver Relations Telegram is not connected; notifications stay pending');
      return;
    }
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref();
    this.logger.log('Driver Relations Telegram notifications are on');
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async tick(now: Date = new Date()): Promise<{ sent: number; failed: number; skipped: number }> {
    const result = { sent: 0, failed: 0, skipped: 0 };
    if (!this.telegram.enabled() || this.running) return result;
    this.running = true;
    try {
      const claimed = await this.database.db.transaction(async (tx) => {
        const due = await tx
          .select({
            id: driverRelationOutbox.id,
            attempts: driverRelationOutbox.attempts,
            createdAt: driverRelationOutbox.createdAt,
            eventType: driverRelationOutbox.eventType,
            requestId: driverRelationOutbox.requestId,
            companyId: driverRelationOutbox.companyId,
          })
          .from(driverRelationOutbox)
          .where(
            and(
              eq(driverRelationOutbox.adapter, 'telegram'),
              eq(driverRelationOutbox.status, 'pending'),
              lte(driverRelationOutbox.retryAt, now),
            ),
          )
          .orderBy(asc(driverRelationOutbox.retryAt))
          .limit(BATCH)
          .for('update', { skipLocked: true });
        for (const row of due) {
          await tx
            .update(driverRelationOutbox)
            .set({ retryAt: new Date(now.getTime() + LEASE_MS), updatedAt: now })
            .where(eq(driverRelationOutbox.id, row.id));
        }
        return due;
      });

      for (const row of claimed) {
        if (now.getTime() - row.createdAt.getTime() > STALE_AFTER_MS) {
          await this.finish(row.id, { status: 'skipped', lastError: 'Older than a day when Telegram could send it' }, now);
          result.skipped += 1;
          continue;
        }
        const [request] = await this.database.db
          .select()
          .from(driverRelationRequests)
          .where(and(eq(driverRelationRequests.companyId, row.companyId), eq(driverRelationRequests.id, row.requestId)))
          .limit(1);
        if (!request) {
          await this.finish(row.id, { status: 'skipped', lastError: 'Request not found' }, now);
          result.skipped += 1;
          continue;
        }
        try {
          const { messageId } = await this.telegram.send(
            telegramText({
              eventType: row.eventType,
              requestId: request.id,
              requestNumber: request.requestNumber,
              topic: request.topic,
              submittedName: request.submittedName,
              truck: request.truckSnapshot,
              at: row.createdAt,
              confidential: request.confidential,
            }),
          );
          await this.finish(row.id, { status: 'sent', externalId: messageId, sentAt: now, attempts: row.attempts + 1 }, now);
          result.sent += 1;
        } catch (error) {
          const attempts = row.attempts + 1;
          const message = error instanceof Error ? error.message : 'Send failed';
          await this.finish(
            row.id,
            attempts >= MAX_ATTEMPTS
              ? { status: 'failed', attempts, lastError: message }
              : { status: 'pending', attempts, lastError: message, retryAt: new Date(now.getTime() + backoffMs(attempts)) },
            now,
          );
          result.failed += 1;
        }
      }
    } catch (error) {
      this.logger.error(`driver relations outbox: tick failed (${error instanceof Error ? error.message : 'unknown'})`);
    } finally {
      this.running = false;
    }
    return result;
  }

  private async finish(
    id: string,
    set: Partial<typeof driverRelationOutbox.$inferInsert>,
    now: Date,
  ): Promise<void> {
    await this.database.db
      .update(driverRelationOutbox)
      .set({ ...set, updatedAt: now })
      .where(and(eq(driverRelationOutbox.id, id), sql`${driverRelationOutbox.status} = 'pending'`));
  }
}
