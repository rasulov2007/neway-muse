import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkServerIdentity, type PeerCertificate } from 'node:tls';
import { describe, expect, it } from 'vitest';
import { rtsCertificateName, rtsTlsOptions } from './rts-tls';

/** What RTS's server presents: a certificate naming only the canonical host. */
const rtsCert = {
  subject: { CN: 'ftps.financial.rtspro.com' },
  subjectaltname: 'DNS:ftps.financial.rtspro.com',
} as unknown as PeerCertificate;

/** A certificate for some other server entirely. */
const otherCert = {
  subject: { CN: 'ftp.example.com' },
  subjectaltname: 'DNS:ftp.example.com',
} as unknown as PeerCertificate;

/** The identity check a TLS socket would run with these options (Node's own when none is given). */
const verify = (host: string, cert: PeerCertificate) => {
  const options = rtsTlsOptions(host);
  const check = options.checkServerIdentity ?? checkServerIdentity;
  return check(options.servername ?? host, cert);
};

describe('RTS FTPS certificate names', () => {
  it('the plain check refuses the alias, which is the bug', () => {
    expect(checkServerIdentity('ftps.rtsfinancial.com', rtsCert)).toBeInstanceOf(Error);
  });

  it('verifies the alias host against the canonical RTS name', () => {
    expect(verify('ftps.rtsfinancial.com', rtsCert)).toBeUndefined();
    expect(rtsTlsOptions('ftps.rtsfinancial.com').servername).toBe('ftps.financial.rtspro.com');
    expect(rtsCertificateName('ftps.rtsfinancial.com')).toBe('ftps.financial.rtspro.com');
  });

  it('matches the alias case-insensitively and ignores a trailing dot', () => {
    expect(verify('FTPS.RTSFinancial.com.', rtsCert)).toBeUndefined();
    expect(verify(' ftps.rtsfinancial.com ', rtsCert)).toBeUndefined();
  });

  it('still refuses the alias when the certificate is not RTS’s', () => {
    expect(verify('ftps.rtsfinancial.com', otherCert)).toBeInstanceOf(Error);
  });

  it('keeps the normal check for the canonical host and every other host', () => {
    expect(rtsTlsOptions('ftps.financial.rtspro.com')).toEqual({});
    expect(verify('ftps.financial.rtspro.com', rtsCert)).toBeUndefined();
    expect(rtsTlsOptions('ftp.example.com')).toEqual({});
    // An unrelated host whose certificate does not name it is refused.
    expect(verify('ftp.example.com', rtsCert)).toBeInstanceOf(Error);
    expect(verify('rtsfinancial.com.evil.example', rtsCert)).toBeInstanceOf(Error);
  });

  it('never turns certificate verification off', () => {
    for (const host of ['ftps.rtsfinancial.com', 'ftps.financial.rtspro.com', 'ftp.example.com']) {
      expect(rtsTlsOptions(host)).not.toHaveProperty('rejectUnauthorized');
    }
    for (const file of ['rts-tls.ts', 'rts-ftp.service.ts']) {
      const source = readFileSync(join(__dirname, file), 'utf8');
      expect(source, file).not.toMatch(/rejectUnauthorized\s*:/);
      expect(source, file).not.toMatch(/NODE_TLS_REJECT_UNAUTHORIZED/);
    }
  });
});
