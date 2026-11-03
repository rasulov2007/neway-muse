import type { LicenseEntry, RoadTest } from '@neway/shared';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { Writer } from './dot-application-pdf';

/**
 * The road test certificate, 49 CFR 391.31(e): who was tested, on what, by whom, and the result.
 * Rendered when orientation records a pass and filed in the qualification file as `road_test`.
 */
export interface RoadTestPdfInput {
  companyName: string;
  driverName: string;
  driverId: string;
  license: LicenseEntry | null;
  roadTest: RoadTest;
  generatedAt: Date;
}

export async function renderRoadTestCertificatePdf(input: RoadTestPdfInput): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(`Road test certificate — ${input.driverName}`);
  doc.setProducer('NeWay TMS');
  doc.setCreationDate(input.generatedAt);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const w = new Writer(
    doc,
    font,
    bold,
    `${input.companyName} · Road test certificate · ${input.driverId} · generated ${input.generatedAt.toISOString().slice(0, 10)}`,
  );

  w.title('Certification of road test', `${input.companyName} · 49 CFR 391.31(e)`);
  w.field('Driver', input.driverName);
  w.field(
    'Driver licence',
    input.license
      ? `${input.license.state} ${input.license.number}, class ${input.license.licenseClass}`
      : 'Not recorded',
  );
  w.field('Type of vehicle used', input.roadTest.vehicleType);
  w.field('Date of test', input.roadTest.testedOn);
  w.field('Result', input.roadTest.result === 'pass' ? 'Passed' : 'Failed');
  w.space();
  w.paragraph(
    'It is my considered opinion that this driver possesses sufficient driving skill to operate safely the type of commercial motor vehicle listed above.',
  );
  w.space();
  w.field('Examiner', input.roadTest.examinerName);
  if (input.roadTest.notes) {
    w.space();
    w.paragraph(input.roadTest.notes);
  }
  return doc.save();
}
