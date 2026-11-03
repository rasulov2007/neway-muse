import {
  CERTIFICATION_STATEMENT,
  type DotApplicationForm,
  type EmploymentEntry,
} from '@neway/shared';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFImage, type PDFPage } from 'pdf-lib';

/**
 * The DOT employment application as a document.
 *
 * Plain Helvetica on US Letter, one section per paragraph of 49 CFR 391.21, the applicant's
 * certification and typed signature at the end. This is the file the qualification file keeps;
 * nothing about it is decorative, and everything on it comes from the form the recruiter recorded.
 *
 * The social security number is printed here and nowhere else in the system.
 */
export interface DotApplicationPdfInput {
  companyName: string;
  applicantNumber: string;
  form: DotApplicationForm;
  /** Sealed at rest; unsealed only to print. */
  ssn: string | null;
  generatedAt: Date;
  /** Certified by the driver through the link and accepted by a recruiter (owner, 2026-10-07). */
  electronic?: { certifiedAt: Date; certifiedName: string | null; acceptedBy: string; acceptedAt: Date };
}

/** A moment as the company reads it: US Eastern, with the zone named. */
function eastern(at: Date): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  })
    .format(at)
    // Intl puts a narrow no-break space before AM/PM, which the PDF's standard font cannot encode.
    .replace(/[\u202f\u00a0]/g, ' ');
}

export const PAGE = { width: 612, height: 792 } as const;
export const MARGIN = 54;
const BODY = 10;
const LINE = 14;

/** A minimal top-down text layout on US Letter, shared by every document this module renders. */
export class Writer {
  private page!: PDFPage;
  private y = 0;

  constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
    private readonly footer: string,
  ) {
    this.newPage();
  }

  private newPage(): void {
    this.page = this.doc.addPage([PAGE.width, PAGE.height]);
    this.y = PAGE.height - MARGIN;
    this.page.drawText(this.footer, {
      x: MARGIN,
      y: MARGIN / 2,
      size: 7.5,
      font: this.font,
      color: rgb(0.45, 0.45, 0.45),
    });
  }

  private ensure(lines: number): void {
    if (this.y - lines * LINE < MARGIN) this.newPage();
  }

  heading(text: string): void {
    this.ensure(3);
    this.y -= LINE * 0.6;
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 11.5, font: this.bold });
    this.y -= 4;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: PAGE.width - MARGIN, y: this.y },
      thickness: 0.6,
      color: rgb(0.6, 0.6, 0.6),
    });
    this.y -= LINE;
  }

  title(text: string, subtitle: string): void {
    this.page.drawText(text, { x: MARGIN, y: this.y, size: 16, font: this.bold });
    this.y -= LINE * 1.4;
    this.page.drawText(subtitle, {
      x: MARGIN,
      y: this.y,
      size: BODY,
      font: this.font,
      color: rgb(0.3, 0.3, 0.3),
    });
    this.y -= LINE * 1.6;
  }

  /** A label and a value on one line. */
  field(label: string, value: string | null | undefined): void {
    this.ensure(1);
    this.page.drawText(`${label}:`, { x: MARGIN, y: this.y, size: BODY, font: this.bold });
    const labelWidth = this.bold.widthOfTextAtSize(`${label}:`, BODY);
    this.page.drawText(value && value.length > 0 ? value : '—', {
      x: MARGIN + Math.max(150, labelWidth + 10),
      y: this.y,
      size: BODY,
      font: this.font,
    });
    this.y -= LINE;
  }

  /** Word-wrapped paragraph. */
  paragraph(text: string, options: { indent?: number; size?: number; bold?: boolean } = {}): void {
    const indent = options.indent ?? 0;
    const size = options.size ?? BODY;
    const font = options.bold ? this.bold : this.font;
    const maxWidth = PAGE.width - MARGIN * 2 - indent;
    const lines: string[] = [];
    let current = '';
    for (const word of text.split(/\s+/)) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current) lines.push(current);
    for (const line of lines) {
      this.ensure(1);
      this.page.drawText(line, { x: MARGIN + indent, y: this.y, size, font });
      this.y -= LINE;
    }
  }

  /** An embedded image, scaled to `width` points, on its own lines. */
  image(image: PDFImage, width: number): void {
    const scaled = image.scale(Math.min(1, width / image.width));
    this.ensure(Math.ceil(scaled.height / LINE) + 1);
    this.y -= scaled.height;
    this.page.drawImage(image, { x: MARGIN, y: this.y, width: scaled.width, height: scaled.height });
    this.y -= LINE;
  }

  /**
   * A typed electronic signature drawn as a signature: the signer's name, large, in an italic face,
   * over a signing line — so the document shows a signature, not only a field value.
   */
  signature(text: string, face: PDFFont): void {
    const size = 26;
    this.ensure(4);
    this.y -= size;
    this.page.drawText(text, { x: MARGIN + 8, y: this.y, size, font: face });
    this.y -= 8;
    this.page.drawLine({ start: { x: MARGIN, y: this.y }, end: { x: MARGIN + 280, y: this.y }, thickness: 0.6 });
    this.y -= LINE;
  }

  none(text: string): void {
    this.paragraph(text, { indent: 12 });
  }

  space(lines = 0.5): void {
    this.y -= LINE * lines;
  }
}

function span(from: string, to: string | null): string {
  return `${from} to ${to ?? 'present'}`;
}

function employment(w: Writer, entry: EmploymentEntry, index: number): void {
  if (entry.kind === 'gap') {
    w.paragraph(`${index}. Not employed, ${span(entry.from, entry.to)} — ${entry.explanation}`, {
      indent: 12,
    });
    return;
  }
  w.paragraph(`${index}. ${entry.employer} — ${entry.position}, ${span(entry.from, entry.to)}`, {
    indent: 12,
    bold: true,
  });
  const details = [
    entry.address ? `Address: ${entry.address}` : null,
    entry.phone ? `Phone: ${entry.phone}` : null,
    entry.contactName ? `Contact: ${entry.contactName}` : null,
    `Drove a commercial motor vehicle: ${entry.droveCmv ? 'yes' : 'no'}`,
    `Employer subject to the FMCSRs: ${entry.dotRegulated ? 'yes' : 'no'}`,
    `Position subject to Part 382 drug and alcohol testing: ${entry.subjectToDrugTesting ? 'yes' : 'no'}`,
    entry.reasonForLeaving ? `Reason for leaving: ${entry.reasonForLeaving}` : null,
  ].filter((d): d is string => d !== null);
  for (const line of details) w.paragraph(line, { indent: 24 });
  w.space(0.3);
}

export async function renderDotApplicationPdf(input: DotApplicationPdfInput): Promise<Uint8Array> {
  const { form } = input;
  const doc = await PDFDocument.create();
  doc.setTitle(`DOT employment application — ${form.legalFirstName} ${form.legalLastName}`);
  doc.setProducer('NeWay TMS');
  doc.setCreationDate(input.generatedAt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(
    doc,
    font,
    bold,
    `${input.companyName} · Driver application ${input.applicantNumber} · generated ${input.generatedAt.toISOString().slice(0, 10)} · contains personal information`,
  );

  w.title('Application for employment — commercial driver', `${input.companyName} · 49 CFR 391.21`);

  w.heading('1. Applicant');
  w.field(
    'Legal name',
    [form.legalFirstName, form.legalMiddleName, form.legalLastName].filter(Boolean).join(' '),
  );
  w.field('Date of birth', form.dateOfBirth);
  w.field('Social security number', input.ssn ?? 'Not provided');

  w.heading('2. Residences, last three years');
  if (form.addresses.length === 0) w.none('None listed.');
  for (const a of [...form.addresses].sort((x, y) => y.from.localeCompare(x.from))) {
    w.paragraph(`${a.street}, ${a.city}, ${a.state} ${a.zip} — ${span(a.from, a.to)}`, {
      indent: 12,
    });
  }

  w.heading('3. Driver licences');
  if (form.licenses.length === 0) w.none('None listed.');
  for (const l of form.licenses) {
    w.paragraph(
      `${l.state} ${l.number} — class ${l.licenseClass}${l.endorsements.length ? `, endorsements ${l.endorsements.join(' ')}` : ''}, expires ${l.expiresOn}`,
      { indent: 12 },
    );
  }
  w.space(0.3);
  w.field(
    'Licence denied, revoked or suspended',
    form.licenseDeniedOrRevoked ? `Yes — ${form.licenseDeniedOrRevokedDetail ?? ''}` : 'No',
  );

  w.heading('4. Employment history');
  w.paragraph(
    'All employers in the last three years, and every employer for which the applicant drove a commercial motor vehicle in the last ten years. Breaks of a month or longer are explained.',
    { size: 8.5 },
  );
  w.space(0.4);
  if (form.employment.length === 0) w.none('None listed.');
  [...form.employment]
    .sort((x, y) => y.from.localeCompare(x.from))
    .forEach((entry, i) => employment(w, entry, i + 1));

  w.heading('5. Accidents, last three years');
  if (form.accidents.length === 0) w.none('None.');
  for (const a of form.accidents) {
    w.paragraph(
      `${a.date} — ${a.location}: ${a.nature}. Fatalities ${a.fatalities}, injuries ${a.injuries}${a.hazmatSpill ? ', hazardous material spill' : ''}.`,
      { indent: 12 },
    );
  }

  w.heading('6. Traffic convictions and forfeitures, last three years');
  if (form.convictions.length === 0) w.none('None.');
  for (const c of form.convictions) {
    w.paragraph(`${c.date} — ${c.location}: ${c.offense}${c.penalty ? ` (${c.penalty})` : ''}`, {
      indent: 12,
    });
  }

  w.heading('7. Certification');
  w.paragraph(CERTIFICATION_STATEMENT);
  w.space(0.8);
  w.field('Signed', form.certifiedName ?? 'Not signed');
  w.field('Date', form.certifiedOn ?? '—');
  if (input.electronic) {
    w.space(0.4);
    w.paragraph(
      `Certified electronically by ${input.electronic.certifiedName ?? form.certifiedName ?? 'the applicant'} on ${eastern(input.electronic.certifiedAt)}, through the private link sent by recruiting. Accepted by ${input.electronic.acceptedBy} on ${eastern(input.electronic.acceptedAt)}.`,
    );
  }

  return doc.save();
}
