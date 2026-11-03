import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { RTS_FTP_COLUMNS, RTS_FTP_PAGE } from '@neway/shared';
import { PDFDocument } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { RtsBatchesService, type RtsBatchRecord } from '../src/modules/accounting/rts-batches.service';
import { RtsFtpService } from '../src/modules/admin/connectors/rts-ftp.service';

/**
 * RTS over FTPS (RTS "FTP Integration Requirements", 2026-10-19): one `<invoice#>.pdf` per invoice
 * on 8 x 10 portrait pages with the NOA stamp, a seven-column CSV, and a send that refuses before
 * anything moves. Reads an existing local batch; changes no invoice. Skips when there is none.
 */
describe('RTS FTPS files (e2e)', () => {
  let app: NestFastifyApplication;
  let svc: RtsBatchesService;
  let batch: RtsBatchRecord | undefined;
  const principal: Principal = { userId: 'usr_rts', userName: 'RTS spec', companyId: 'co_northwind', companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set(['accounting.view', 'accounting.edit']) };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    svc = app.get(RtsBatchesService);
    batch = (await svc.batches(principal)).find((b) => b.status !== 'cancelled' && b.lines.length > 0);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  it('builds one PDF per invoice named after it, 8 x 10 portrait, and the RTS CSV', async () => {
    if (!batch) return;
    const { pdfs, csv } = await (svc as unknown as { ftpSubmission: (p: Principal, r: RtsBatchRecord, c: string) => Promise<{ pdfs: Array<{ name: string; data: Buffer }>; csv: { name: string; data: Buffer }; problems: string[] }> }).ftpSubmission(principal, batch, 'TESTCLIENT');
    if (process.env.RTS_DUMP) { const fs = await import('node:fs'); fs.writeFileSync(process.env.RTS_DUMP + '/' + pdfs[0]!.name, pdfs[0]!.data); fs.writeFileSync(process.env.RTS_DUMP + '/' + csv.name, csv.data); }
    expect(pdfs.map((p) => p.name)).toEqual(batch.lines.map((l) => `${l.invoiceNumber}.pdf`));
    for (const f of pdfs) {
      const doc = await PDFDocument.load(f.data);
      expect(doc.getPageCount()).toBeGreaterThan(0);
      for (const page of doc.getPages()) expect([Math.round(page.getWidth()), Math.round(page.getHeight())]).toEqual([RTS_FTP_PAGE.width, RTS_FTP_PAGE.height]);
    }
    const lines = csv.data.toString().trim().split(/\r?\n/);
    expect(lines[0]).toBe(RTS_FTP_COLUMNS.join(','));
    expect(lines).toHaveLength(batch.lines.length + 1);
    expect(lines[1]!.startsWith('TESTCLIENT,')).toBe(true);
    expect(lines[1]).toMatch(/,\d{2}\/\d{2}\/\d{4},\d+\.\d{2}$/);
  });

  it('refuses to send a batch already submitted, before touching RTS', async () => {
    const submitted = (await svc.batches(principal)).find((b) => b.status === 'submitted');
    if (!submitted) return;
    const { version } = await svc.batch(principal, submitted.id);
    await expect(svc.sendFtp(principal, submitted.id, version)).rejects.toThrow(/already submitted/);
  });

  it('sends three TEST packets and their CSV through a test account only (2026-10-20)', async () => {
    const ftp = app.get(RtsFtpService);
    const sent: Array<{ pdfs: string[]; csv: string }> = [];
    const realUploader = ftp.uploader.bind(ftp);
    const realUpload = ftp.upload.bind(ftp);
    ftp.uploader = async () => ({ ok: true, accountId: 'int_spec', name: 'RTS test', clientNumber: 'TESTCLIENT', host: 'ftps.example', test: true });
    ftp.upload = async (_c, _a, pdfs, csv) => {
      for (const f of pdfs) expect((await PDFDocument.load(f.data)).getPageCount()).toBe(4);
      sent.push({ pdfs: pdfs.map((f) => f.name), csv: csv.data.toString() });
      return { uploaded: [...pdfs.map((f) => f.name), csv.name] };
    };
    try {
      const r = await svc.sendTestPackets(principal);
      expect(sent[0]!.pdfs).toEqual(['TEST-0001.pdf', 'TEST-0002.pdf', 'TEST-0003.pdf']);
      const lines = r.csv.trim().split(/\r?\n/);
      expect(lines).toHaveLength(4);
      expect(lines[1]).toMatch(/^TESTCLIENT,TEST-0001,Test Debtor One,Test Debtor One,TEST-LOAD-0001,\d{2}\/\d{2}\/\d{4},1200\.00$/);
      // Within five minutes of the last drop, RTS's gap holds.
      await expect(svc.sendTestPackets(principal)).rejects.toThrow(/five minutes|every 5 minutes/);
      ftp.uploader = async () => ({ ok: true, accountId: 'int_spec', name: 'RTS', clientNumber: 'X', host: 'h', test: false });
      await expect(svc.sendTestPackets(principal)).rejects.toThrow(/test account only/);
    } finally {
      ftp.uploader = realUploader;
      ftp.upload = realUpload;
    }
  }, 120_000);
});
