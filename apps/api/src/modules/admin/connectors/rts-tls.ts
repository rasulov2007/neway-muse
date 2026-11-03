import { checkServerIdentity, type ConnectionOptions, type PeerCertificate } from 'node:tls';
import { RTS_FTP_HOST } from '@neway/shared';

/**
 * Names RTS hands out for its FTPS server whose certificate does not carry them.
 *
 * `ftps.rtsfinancial.com` resolves to the same server as `ftps.financial.rtspro.com`, but the
 * certificate there names only `ftps.financial.rtspro.com`, so a plain check refuses it with
 * "Host: ftps.rtsfinancial.com. is not in the cert's altnames". The alias is connected to as typed
 * and its certificate is verified - fully - against the canonical name. Nothing else is relaxed.
 */
const RTS_HOST_ALIASES: Readonly<Record<string, string>> = {
  'ftps.rtsfinancial.com': RTS_FTP_HOST,
};

/** Lower case, no trailing dot: `FTPS.RTSFinancial.com.` and `ftps.rtsfinancial.com` are one host. */
function normaliseHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '');
}

/** The name the certificate must carry for `host`: the canonical RTS name for a known alias, else `host`. */
export function rtsCertificateName(host: string): string {
  return RTS_HOST_ALIASES[normaliseHost(host)] ?? host;
}

/**
 * TLS options for an RTS FTPS session. basic-ftp keeps these and reuses them for every passive
 * data connection, so the alias rule covers uploads and listings as well as the login.
 *
 * Verification is never turned off: `rejectUnauthorized` is not set (Node defaults it to true),
 * the chain is still checked against the system CAs, and the identity check is Node's own,
 * only pointed at the canonical name for a listed alias.
 */
export function rtsTlsOptions(host: string): ConnectionOptions {
  const canonical = RTS_HOST_ALIASES[normaliseHost(host)];
  if (!canonical) return {};
  return {
    servername: canonical,
    checkServerIdentity: (_host: string, cert: PeerCertificate) => checkServerIdentity(canonical, cert),
  };
}
