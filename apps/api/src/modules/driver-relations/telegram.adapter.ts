import { Injectable } from '@nestjs/common';
import { env } from '../../config/env';

/**
 * The Driver Relations → Telegram adapter (owner, 2026-10-06): one management group, one bot.
 *
 * DISABLED until the owner configures it. `enabled()` is false unless DR_TELEGRAM_ENABLED=true
 * and both TELEGRAM_DR_BOT_TOKEN and TELEGRAM_DR_CHAT_ID are set, and `send()` refuses to run
 * while it is false, so no code path reaches Telegram by accident. The token never appears in a
 * log line, an error message or a response: errors carry Telegram's own description only.
 *
 * Outbound only. There is no webhook and no command: a Telegram "seen" never counts as contact,
 * and contact is recorded in the TMS with a note.
 */
@Injectable()
export class TelegramAdapter {
  /** Overridable in tests; the real transport otherwise. */
  transport: typeof fetch = (input, init) => fetch(input, init);

  enabled(): boolean {
    return env.DR_TELEGRAM_ENABLED && Boolean(env.TELEGRAM_DR_BOT_TOKEN) && Boolean(env.TELEGRAM_DR_CHAT_ID);
  }

  async send(text: string): Promise<{ messageId: string }> {
    if (!this.enabled()) throw new Error('Telegram is not connected for Driver Relations');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    let response: Response;
    try {
      response = await this.transport(
        `https://api.telegram.org/bot${env.TELEGRAM_DR_BOT_TOKEN}/sendMessage`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_DR_CHAT_ID,
            text,
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          }),
          signal: controller.signal,
        },
      );
    } catch {
      throw new Error('Telegram could not be reached');
    } finally {
      clearTimeout(timer);
    }
    const json = (await response.json().catch(() => null)) as {
      ok?: boolean;
      description?: string;
      result?: { message_id?: number };
    } | null;
    if (!response.ok || !json?.ok) {
      throw new Error(`Telegram refused the message (${response.status}${json?.description ? `: ${json.description.slice(0, 200)}` : ''})`);
    }
    return { messageId: String(json.result?.message_id ?? '') };
  }
}
