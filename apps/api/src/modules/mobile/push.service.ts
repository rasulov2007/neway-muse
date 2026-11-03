import { Injectable, Logger } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { DeepLink, MobilePushPayload } from '@neway/shared';
import { DatabaseService } from '../../database/database.service';
import { mobileDevices, mobilePushLog } from '../../database/schema/mobile';

const DEFAULT_EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';

/**
 * Expo push (https://docs.expo.dev/push-notifications/sending-notifications/).
 *
 * Called after the notification row is written, never before: a push that fails is logged in
 * `mobile_push_log` and the notification is still in the person's inbox. The message carries a
 * generic title and body and the deep link only - never an amount, a reason or a document's
 * content. EXPO_PUSH_URL points tests at a local stub; EXPO_ACCESS_TOKEN is optional.
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  /** Read at send time so a test can point it at a stub. */
  get url(): string {
    return process.env.EXPO_PUSH_URL?.trim() || DEFAULT_EXPO_PUSH_URL;
  }

  constructor(private readonly database: DatabaseService) {}

  async sendToUser(
    companyId: string,
    userId: string,
    notificationId: string,
    message: { title: string; body: string; target: DeepLink | null },
  ): Promise<number> {
    const db = this.database.db;
    const devices = await db
      .select({ id: mobileDevices.id, token: mobileDevices.expoToken })
      .from(mobileDevices)
      .where(and(eq(mobileDevices.companyId, companyId), eq(mobileDevices.userId, userId), isNull(mobileDevices.revokedAt)));
    if (devices.length === 0) return 0;

    const payloads: MobilePushPayload[] = devices.map((d) => ({
      to: d.token,
      title: message.title,
      body: message.body,
      sound: 'default',
      data: {
        type: message.target?.type ?? 'notification',
        id: message.target?.id ?? notificationId,
        ...(message.target?.parentId ? { parentId: message.target.parentId } : {}),
        notificationId,
      },
    }));

    let answers: Array<{ status?: string; id?: string; message?: string; details?: { error?: string } }> = [];
    let failure: string | null = null;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
      const token = process.env.EXPO_ACCESS_TOKEN?.trim();
      if (token) headers['authorization'] = `Bearer ${token}`;
      const response = await fetch(this.url, { method: 'POST', headers, body: JSON.stringify(payloads), signal: AbortSignal.timeout(5000) });
      if (!response.ok) failure = `HTTP ${response.status}`;
      else {
        const json = (await response.json().catch(() => null)) as { data?: typeof answers } | null;
        answers = Array.isArray(json?.data) ? json.data : [];
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }

    const now = new Date();
    for (const [i, device] of devices.entries()) {
      const answer = answers[i];
      const error = failure ?? (answer && answer.status !== 'ok' ? (answer.details?.error ?? answer.message ?? 'error') : null);
      await db.insert(mobilePushLog).values({
        id: `push_${crypto.randomUUID()}`,
        companyId,
        notificationId,
        deviceId: device.id,
        status: error ? 'error' : 'sent',
        error,
        ticketId: answer?.id ?? null,
        createdAt: now,
      });
      // Expo says the app was uninstalled or the token is dead: stop sending to it.
      if (answer?.details?.error === 'DeviceNotRegistered') {
        await db.update(mobileDevices).set({ revokedAt: now, revokedReason: 'device_not_registered' }).where(eq(mobileDevices.id, device.id));
      }
    }
    if (failure) this.logger.warn(`Push for notification ${notificationId} failed: ${failure}`);
    return devices.length;
  }
}
