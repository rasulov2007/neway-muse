import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { DOT_APP_STEP_TITLES, signatureDocKey, signatureLabel, type DotAppAnswers, type DotAppCompanyBrand } from '@neway/shared';
import type { DocumentStorageService } from '../../common/storage/document-storage.service';
import type { ApplicationDocumentTemplateRow, DotApplicationSignatureRow, DotDriverApplicationRow } from '../../database/schema/dot-application';

/**
 * The signed application as a PDF for the driver's qualification file: the answers section by
 * section, then every signature with its evidence (document, version, signer, time, IP, evidence
 * digest) and the drawn image. The SSN is printed masked.
 */

const A4 = { w: 612, h: 792 };
const M = 48;

/** pdf-lib's standard fonts are WinAnsi: replace what they cannot draw. */
function ascii(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, '-')
    .replace(/[•]/g, '*')
    .replace(/[^\x20-\x7e\xa0-\xff]/g, '?');
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
    private readonly header: string,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.doc.addPage([A4.w, A4.h]);
    this.y = A4.h - M;
    this.page.drawText(ascii(this.header), { x: M, y: A4.h - 28, size: 8, font: this.font, color: rgb(0.4, 0.45, 0.43) });
  }
  ensure(h: number) {
    if (this.y - h < M) this.newPage();
  }
  wrap(text: string, size: number, font: PDFFont, width: number): string[] {
    const out: string[] = [];
    for (const para of ascii(text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const next = line ? `${line} ${word}` : word;
        if (font.widthOfTextAtSize(next, size) > width && line) {
          out.push(line);
          line = word;
        } else line = next;
      }
      out.push(line);
    }
    return out;
  }
  text(text: string, opts: { size?: number; bold?: boolean; indent?: number; color?: [number, number, number] } = {}) {
    const size = opts.size ?? 9.5;
    const font = opts.bold ? this.bold : this.font;
    const x = M + (opts.indent ?? 0);
    for (const line of this.wrap(text, size, font, A4.w - M - x)) {
      this.ensure(size + 4);
      this.page.drawText(line, { x, y: this.y - size, size, font, color: rgb(...(opts.color ?? [0.08, 0.14, 0.11])) });
      this.y -= size + 3.5;
    }
  }
  gap(n = 6) {
    this.y -= n;
  }
  kv(k: string, v: string) {
    const size = 9;
    const lines = this.wrap(v || '—', size, this.font, A4.w - M * 2 - 170);
    this.ensure(lines.length * (size + 3.5) + 2);
    this.page.drawText(ascii(k), { x: M, y: this.y - size, size, font: this.font, color: rgb(0.36, 0.42, 0.4) });
    for (const l of lines) {
      this.page.drawText(l, { x: M + 170, y: this.y - size, size, font: this.bold });
      this.y -= size + 3.5;
    }
  }
}

const yn = (v: unknown) => (typeof v === 'string' ? v : v === true ? 'Yes' : v === false ? 'No' : '');
const addr = (a?: { street?: string; city?: string; state?: string; zip?: string; country?: string }) => [a?.street, a?.city, a?.state, a?.zip, a?.country].filter(Boolean).join(', ');

export async function applicationPdf(p: {
  app: DotDriverApplicationRow;
  company: DotAppCompanyBrand;
  signatures: DotApplicationSignatureRow[];
  templates: Map<string, ApplicationDocumentTemplateRow>;
  storage: DocumentStorageService;
}): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setTitle(`DOT driver application — ${p.app.candidateName}`);
  doc.setAuthor(p.company.legalName);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const a = p.app.answers as DotAppAnswers;
  const w = new Writer(doc, font, bold, `${p.company.legalName} · DOT driver application · ${p.app.candidateName} · ${p.app.id}`);
  w.text(p.company.legalName, { size: 15, bold: true });
  w.text('DRIVER APPLICATION', { size: 8, bold: true, color: [0.23, 0.35, 0.29] });
  w.gap(8);
  w.kv('Applicant', [a.personal?.firstName, a.personal?.middleName, a.personal?.lastName].filter(Boolean).join(' '));
  w.kv('Reserved driver ID', p.app.driverId ? `D-${p.app.driverId.replace(/^drv_/, '')}` : '');
  w.kv('Submitted', p.app.submittedAt?.toISOString() ?? '');
  w.kv('Safety approved', p.app.approvedAt ? `${p.app.approvedAt.toISOString()} by ${p.app.approvedByName ?? ''}` : '');
  w.gap(10);

  const section = (t: string) => {
    w.gap(6);
    w.text(t, { size: 11.5, bold: true });
    w.gap(2);
  };
  section(DOT_APP_STEP_TITLES.personal);
  w.kv('Address', addr(a.personal?.address));
  w.kv('Residence 3 years or longer', yn(a.personal?.res3));
  (a.personal?.prevAddresses ?? []).forEach((x, i) => w.kv(`Previous address ${i + 1}`, `${addr(x)} (${x.from ?? ''} – ${x.to ?? ''})`));
  w.kv('SSN/SIN', p.app.ssnLast4 ? `***-**-${p.app.ssnLast4}` : '');
  w.kv('Date of Birth', a.personal?.dob ?? '');
  w.kv('Primary Phone', a.personal?.phone ?? '');
  w.kv('Email', a.personal?.email ?? '');
  section(DOT_APP_STEP_TITLES.company);
  const c = a.company ?? {};
  for (const [k, v] of [
    ['Position', c.position],
    ['Location', c.location],
    ['Owner Operator / Fleet Owner', c.isOwner],
    ['Legally eligible to work in the US', c.eligible],
    ['Currently employed', c.employed],
    ['Last employment ended', c.lastEnd],
    ['Reads, writes, speaks English', c.english],
    ['Worked for this company before', c.workedBefore],
    ['Details', c.workedBeforeDetails],
    ['Current TWIC card', c.twic],
    ['TWIC expiration', c.twicExp],
    ['Known by another name', c.otherName],
    ['Other name', c.otherNameText],
    ['How heard', [c.heard, c.referral, c.heardOther].filter(Boolean).join(' — ')],
  ] as const)
    if (v) w.kv(k, String(v));
  (c.equipment ?? []).forEach((t, i) => w.kv(`Tractor ${i + 1}`, [t.type, t.year, t.make, t.model, t.color, `VIN ${t.vin ?? ''}`].filter(Boolean).join(' · ')));
  section(DOT_APP_STEP_TITLES.license);
  w.kv('Experience', `Straight ${a.exp?.straight ?? ''} · Tractor-semi ${a.exp?.tractorSemi ?? ''} · Two trailers ${a.exp?.twoTrailers ?? ''} · Other ${a.exp?.other ?? ''}`);
  (a.licenses ?? []).forEach((l, i) =>
    w.kv(`License ${i + 1}`, `${l.number ?? ''} · ${l.authority ?? ''} · ${l.country ?? ''} · ${l.cls ?? ''} · exp ${l.exp ?? ''} · medical ${l.med ?? ''} · current ${l.current ?? ''} · CDL ${l.cdl ?? ''}${l.endorse?.length ? ` · ${l.endorse.join(', ')}` : ''}`),
  );
  section(DOT_APP_STEP_TITLES.employment);
  (a.employers ?? []).forEach((e, i) => {
    w.kv(`Employer ${i + 1}`, `${e.company ?? ''} (${e.start ?? ''} – ${e.end || 'Present'})`);
    w.kv('', `${addr(e.address)} · ${e.phone ?? ''} · ${e.position ?? ''} · leaving: ${e.reason ?? ''}`);
    w.kv('', `Terminated ${e.terminated ?? ''} · Current ${e.current ?? ''} · May contact ${e.contact ?? ''} · CMV ${e.cmv ?? ''} · FMCSR ${e.fmcsr ?? ''} · DOT tested ${e.dotTesting ?? ''}`);
  });
  (a.unemployment ?? []).forEach((u, i) => w.kv(`Unemployment ${i + 1}`, `${u.start ?? ''} – ${u.end ?? ''} ${u.comment ?? ''}`));
  (a.schools ?? []).forEach((s, i) => w.kv(`Trucking school ${i + 1}`, `${s.school ?? ''} (${s.start ?? ''} – ${s.end ?? ''}) graduated ${s.graduated ?? ''}`));
  section(DOT_APP_STEP_TITLES.history);
  const f = a.fmcsr ?? {};
  w.kv('FMCSR', `Disqualified ${f.disqualified ?? ''} · Suspended/revoked ${f.suspended ?? ''} · Denied ${f.denied ?? ''} · Pre-employment positive ${f.preEmpPositive ?? ''} · Convicted ${f.convicted ?? ''}`);
  w.kv('Accidents (5 years)', a.accidents?.any ?? '');
  (a.accidents?.list ?? []).forEach((x, i) => w.kv(`Accident ${i + 1}`, `${x.date ?? ''} · ${x.location ?? ''} · injuries ${x.injuries ?? ''} · fatalities ${x.fatalities ?? ''} · hazmat ${x.hazmat ?? ''} · CMV ${x.cmv ?? ''} · ${x.desc ?? ''}`));
  w.kv('Violations (3 years)', a.violations?.any ?? '');
  (a.violations?.list ?? []).forEach((x, i) => w.kv(`Violation ${i + 1}`, `${x.date ?? ''} · ${x.state ?? ''} · ${x.charge ?? ''}`));
  const cr = a.criminal ?? {};
  w.kv('Criminal record', `Convicted ${cr.convicted ?? ''} · Deferred ${cr.deferred ?? ''} · Pending ${cr.pending ?? ''} · Felony ${cr.felony ?? ''} · Minister's permit (Canada) ${cr.canadaPermit ?? ''} · Misdemeanor ${cr.misdemeanor ?? ''}`);
  section(DOT_APP_STEP_TITLES.emergency);
  w.kv('Contact #1', [a.emergency?.c1?.name, a.emergency?.c1?.relationship, a.emergency?.c1?.phone, a.emergency?.c1?.address, a.emergency?.c1?.csz].filter(Boolean).join(' · '));
  if (a.emergency?.c2?.name) w.kv('Contact #2', [a.emergency.c2.name, a.emergency.c2.relationship, a.emergency.c2.phone].filter(Boolean).join(' · '));

  if (a.chs?.from || a.chs?.to) {
    section('Clearinghouse — single limited query');
    w.kv('Query period', `${a.chs?.from ?? ''} – ${a.chs?.to ?? ''}`);
  }
  if (a.ach && Object.values(a.ach).some(Boolean)) {
    section('ACH debit authorization');
    w.kv('Print Name (Company Name)', a.ach.name ?? '');
    w.kv('Address', a.ach.address ?? '');
    w.kv('Account type', a.ach.accountType ?? '');
    w.kv('Depository Bank Name', a.ach.bank ?? '');
    // Bank numbers are never printed in full: only the account's last 4.
    w.kv('Routing / Account Number', p.app.bankLast4 ? `on file (sealed) · account ending ${p.app.bankLast4}` : '');
    w.kv('Email', a.ach.email ?? '');
  }

  // Signatures and evidence
  w.newPage();
  w.text('Signatures and evidence', { size: 12.5, bold: true });
  w.gap(4);
  for (const s of [...p.signatures].sort((x, y) => x.signedAt.getTime() - y.signedAt.getTime())) {
    w.ensure(110);
    const title = p.templates.get(signatureDocKey(s.docKey))?.title ?? signatureLabel(s.docKey, a);
    w.text(`${title}`, { bold: true, size: 10 });
    w.kv('Document · version', `${s.docKey} · ${s.docVersion}`);
    w.kv('Signer', `${s.signerName} (${s.signerRole}${s.signerTitle ? `, ${s.signerTitle}` : ''}) — typed "${s.typedName}"`);
    w.kv('Signed', `${s.signedAt.toISOString()} · IP ${s.ip ?? '—'}`);
    w.kv('Evidence', `${s.evidenceSha256} · e-sign consent ${s.esignConsent ? 'yes' : 'no'}`);
    try {
      const img = await doc.embedPng(await p.storage.get(s.imageStorageKey));
      const scale = Math.min(180 / img.width, 50 / img.height);
      w.ensure(56);
      w.page.drawImage(img, { x: M + 170, y: w.y - img.height * scale, width: img.width * scale, height: img.height * scale });
      w.y -= img.height * scale + 4;
    } catch {
      w.kv('Image', 'not available');
    }
    w.gap(8);
  }
  return Buffer.from(await doc.save());
}
