import { HttpException, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { mobileIdempotency } from '../../database/schema/mobile';

const KEY_SHAPE = /^[A-Za-z0-9._:-]{8,200}$/;

/**
 * Idempotency for mobile writes (docs/mobile/API.md §Idempotency).
 *
 * The phone makes an `Idempotency-Key` (a uuid) when the draft is created and sends it with every
 * try. The first request claims (company, membership, key) in `mobile_idempotency`, runs, and
 * stores its answer; a retry gets that stored answer back and no second record is made. A key
 * already used for a different route is refused (422). A request that failed releases its claim,
 * so the corrected retry can run. A retry that arrives while the first is still running gets 409.
 */
@Injectable()
export class IdempotencyService {
  constructor(private readonly database: DatabaseService) {}

  async run<T>(principal: Principal, key: string | undefined, route: string, work: () => Promise<T>): Promise<T> {
    const membershipId = principal.membershipId;
    if (!membershipId) throw new AppError({ status: 403, title: 'Forbidden', detail: 'Mobile writes need a signed-in account.' });
    const clean = (key ?? '').trim();
    if (!clean) {
      throw new AppError({ status: 428, title: 'Precondition Required', detail: 'Send an Idempotency-Key header with every write from the app.' });
    }
    if (!KEY_SHAPE.test(clean)) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'The Idempotency-Key must be 8-200 letters, digits, dots, dashes, colons or underscores.' });
    }
    const db = this.database.db;
    const claimed = await db
      .insert(mobileIdempotency)
      .values({ companyId: principal.companyId, membershipId, key: clean, route })
      .onConflictDoNothing()
      .returning({ key: mobileIdempotency.key });
    const where = and(eq(mobileIdempotency.companyId, principal.companyId), eq(mobileIdempotency.membershipId, membershipId), eq(mobileIdempotency.key, clean));

    if (claimed.length === 0) {
      const [row] = await db.select().from(mobileIdempotency).where(where).limit(1);
      if (!row) throw new AppError({ status: 409, title: 'Conflict', detail: 'That request is being processed. Try again in a moment.' });
      if (row.route !== route) {
        throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'This Idempotency-Key was already used for a different request.' });
      }
      if (!row.completedAt) throw new AppError({ status: 409, title: 'Conflict', detail: 'That request is still being processed. Try again in a moment.' });
      return row.response as T;
    }

    try {
      const result = await work();
      await db
        .update(mobileIdempotency)
        .set({ response: (result ?? null) as never, statusCode: 200, completedAt: new Date() })
        .where(and(where, isNull(mobileIdempotency.completedAt)));
      return result;
    } catch (error) {
      // Nothing was made: release the key so the corrected retry runs. An unexpected crash is
      // released too; the services' own checks (ownership, version) stand behind the retry.
      await db.delete(mobileIdempotency).where(and(where, isNull(mobileIdempotency.completedAt)));
      if (error instanceof HttpException || error instanceof AppError) throw error;
      throw error;
    }
  }
}
