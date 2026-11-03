import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../../../config/env';

/** A Twilio refusal or outage, with Twilio's own code when it gave one. */
export class TwilioError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
    /** A 5xx or a network failure may succeed later; a 4xx will not. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TwilioError';
  }
}

export interface TwilioMessage {
  sid: string;
  /** queued · accepted · scheduled · sending · sent · delivered · undelivered · failed · canceled · read */
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
}

const TIMEOUT_MS = 15_000;

/**
 * Twilio's REST API, the two calls recruiting needs and a read to prove the credential. No SDK:
 * three form posts and a signature check do not justify one. The auth token lives only in this
 * object for the length of a request; nothing here logs it, a recipient or a message body.
 */
export class TwilioClient {
  constructor(
    private readonly accountSid: string,
    private readonly authToken: string,
  ) {}

  private get base(): string {
    return `${env.TWILIO_API_BASE.replace(/\/+$/, '')}/2010-04-01/Accounts/${encodeURIComponent(this.accountSid)}`;
  }

  private get messaging(): string {
    return `${env.TWILIO_MESSAGING_API_BASE.replace(/\/+$/, '')}/v1`;
  }

  private async call(path: string, init: { method: 'GET' | 'POST'; form?: Record<string, string> }, root = this.base): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(`${root}${path}`, {
        method: init.method,
        headers: {
          authorization: `Basic ${Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64')}`,
          accept: 'application/json',
          ...(init.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        },
        body: init.form ? new URLSearchParams(init.form).toString() : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      throw new TwilioError(`Twilio could not be reached (${(error as Error).name})`, 0, null, true);
    } finally {
      clearTimeout(timer);
    }
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const code = body.code === undefined || body.code === null ? null : String(body.code);
      const message = typeof body.message === 'string' ? body.message : `Twilio answered ${response.status}`;
      throw new TwilioError(message, response.status, code, response.status >= 500 || response.status === 429);
    }
    return body;
  }

  private static message(body: Record<string, unknown>): TwilioMessage {
    return {
      sid: String(body.sid ?? ''),
      status: String(body.status ?? 'queued'),
      errorCode: body.error_code === null || body.error_code === undefined ? null : String(body.error_code),
      errorMessage: typeof body.error_message === 'string' ? body.error_message : null,
    };
  }

  /** The account itself: proves the SID and token, and names the account. */
  async account(): Promise<{ friendlyName: string; status: string }> {
    const body = await this.call('.json', { method: 'GET' });
    return { friendlyName: String(body.friendly_name ?? 'Twilio'), status: String(body.status ?? 'unknown') };
  }

  /** `from` is a +E.164 number or a Messaging Service SID (MG…). */
  async send(input: { to: string; from: string; body: string; statusCallback: string | null }): Promise<TwilioMessage> {
    const form: Record<string, string> = { To: input.to, Body: input.body };
    if (/^MG[0-9a-f]{32}$/i.test(input.from)) form.MessagingServiceSid = input.from;
    else form.From = input.from;
    if (input.statusCallback) form.StatusCallback = input.statusCallback;
    return TwilioClient.message(await this.call('/Messages.json', { method: 'POST', form }));
  }

  async fetchMessage(sid: string): Promise<TwilioMessage> {
    return TwilioClient.message(await this.call(`/Messages/${encodeURIComponent(sid)}.json`, { method: 'GET' }));
  }

  /** The array a Twilio list response carries (each list names its own key). */
  private static list(body: Record<string, unknown>): Record<string, unknown>[] {
    for (const value of Object.values(body)) if (Array.isArray(value)) return value as Record<string, unknown>[];
    return [];
  }

  /** The account's own number, or null when the account does not own it. */
  async incomingNumber(phone: string): Promise<{ sid: string; sms: boolean } | null> {
    const body = await this.call(`/IncomingPhoneNumbers.json?PhoneNumber=${encodeURIComponent(phone)}`, { method: 'GET' });
    const row = TwilioClient.list(body)[0];
    if (!row) return null;
    const caps = (row.capabilities ?? {}) as Record<string, unknown>;
    return { sid: String(row.sid ?? ''), sms: caps.sms === true || caps.SMS === true };
  }

  async messagingServices(): Promise<string[]> {
    return TwilioClient.list(await this.call('/Services?PageSize=50', { method: 'GET' }, this.messaging)).map((r) => String(r.sid ?? ''));
  }

  async servicePhoneNumbers(serviceSid: string): Promise<{ sid: string; phone: string }[]> {
    const body = await this.call(`/Services/${encodeURIComponent(serviceSid)}/PhoneNumbers?PageSize=100`, { method: 'GET' }, this.messaging);
    return TwilioClient.list(body).map((r) => ({ sid: String(r.sid ?? ''), phone: String(r.phone_number ?? '') }));
  }

  /** A2P 10DLC campaigns on a Messaging Service: campaign_status PENDING · IN_PROGRESS · FAILED · VERIFIED. */
  async a2pCampaigns(serviceSid: string): Promise<string[]> {
    const body = await this.call(`/Services/${encodeURIComponent(serviceSid)}/Compliance/Usa2p`, { method: 'GET' }, this.messaging);
    return TwilioClient.list(body).map((r) => String(r.campaign_status ?? ''));
  }

  /** Toll-free verification of a number: PENDING_REVIEW · IN_REVIEW · TWILIO_APPROVED · TWILIO_REJECTED. */
  async tollfreeVerifications(phoneSid: string): Promise<string[]> {
    const body = await this.call(`/Tollfree/Verifications?TollfreePhoneNumberSid=${encodeURIComponent(phoneSid)}`, { method: 'GET' }, this.messaging);
    return TwilioClient.list(body).map((r) => String(r.status ?? ''));
  }
}

/** US toll-free area codes. */
export const isTollFree = (e164: string) => /^\+1(800|833|844|855|866|877|888)\d{7}$/.test(e164);

/**
 * Whether the sender may text US numbers: a toll-free number needs an approved toll-free
 * verification; a local number (or a Messaging Service) needs a verified A2P 10DLC campaign on the
 * Messaging Service it sends through. Twilio accepting a request is not the same as carriers
 * delivering it, so this is checked apart from the credential.
 */
export async function senderReadiness(client: TwilioClient, from: string): Promise<{ ready: boolean; detail: string }> {
  const campaignVerified = async (service: string) => (await client.a2pCampaigns(service)).includes('VERIFIED');
  if (/^MG[0-9a-f]{32}$/i.test(from)) {
    if (await campaignVerified(from)) return { ready: true, detail: 'Messaging Service with a verified A2P 10DLC campaign' };
    for (const n of await client.servicePhoneNumbers(from)) {
      if (isTollFree(n.phone) && (await client.tollfreeVerifications(n.sid)).includes('TWILIO_APPROVED')) {
        return { ready: true, detail: `Messaging Service with an approved toll-free number ${n.phone}` };
      }
    }
    return { ready: false, detail: 'The Messaging Service has no verified A2P 10DLC campaign and no approved toll-free number.' };
  }
  const number = await client.incomingNumber(from);
  if (!number) return { ready: false, detail: `${from} is not a number on this Twilio account.` };
  if (!number.sms) return { ready: false, detail: `${from} cannot send SMS.` };
  if (isTollFree(from)) {
    const states = await client.tollfreeVerifications(number.sid);
    return states.includes('TWILIO_APPROVED')
      ? { ready: true, detail: `Toll-free ${from} with an approved toll-free verification` }
      : { ready: false, detail: `Toll-free ${from} is not verified yet (${states[0] ?? 'no verification submitted'}).` };
  }
  for (const service of await client.messagingServices()) {
    const numbers = await client.servicePhoneNumbers(service);
    if (!numbers.some((n) => n.sid === number.sid)) continue;
    return (await campaignVerified(service))
      ? { ready: true, detail: `Local ${from} in a Messaging Service with a verified A2P 10DLC campaign` }
      : { ready: false, detail: `Local ${from} is in a Messaging Service whose A2P 10DLC campaign is not verified yet.` };
  }
  return { ready: false, detail: `Local ${from} is not in a Messaging Service with an A2P 10DLC campaign; US carriers block unregistered 10DLC traffic.` };
}

/**
 * Twilio's request signature: base64 HMAC-SHA1, keyed by the auth token, over the full URL Twilio
 * called followed by every POST parameter as name+value in name order.
 */
export function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, key) => acc + key + params[key], url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

export function twilioSignatureValid(authToken: string, url: string, params: Record<string, string>, given: string | undefined): boolean {
  if (!given) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const actual = Buffer.from(given);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** Twilio's message status → the journey's: accepted by Twilio is "sent", the carrier's word is "delivered". */
export function deliveryStatusOf(twilioStatus: string): 'sending' | 'sent' | 'delivered' | 'failed' {
  switch (twilioStatus) {
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'failed':
    case 'undelivered':
    case 'canceled':
      return 'failed';
    default:
      // queued · accepted · scheduled · sending · sent: Twilio has it; the carrier has not confirmed.
      return 'sent';
  }
}
