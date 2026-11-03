/**
 * A link made for a message the TMS is sending (SMS or email): it is stored revoked with this marker
 * and works — turning the previous link off — only once the provider accepted the message. When the
 * message is refused it is marked NOT_SENT and the previous link keeps working.
 */
export const PENDING_SEND = 'system:awaiting-send';
export const NOT_SENT = 'system:message-not-sent';
