import { describe, expect, it, vi } from 'vitest';
import type { CdlMuseAnswer } from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import type { ComplianceService } from '../compliance/compliance.service';
import type { MuseVisionService } from '../muse-vision/muse-vision.service';
import type { DotApplicationsService } from './dot-applications.service';
import { HiringDocumentsService } from './hiring-documents.service';
import type { HiringService } from './hiring.service';

const principal = { companyId: 'co_test', userId: 'u1', userName: 'Tester' } as never;
const sure = <T>(value: T) => ({ value, confidence: 0.95 });
const card: CdlMuseAnswer = {
  isDriverLicence: true,
  isCommercial: true,
  legalFirstName: sure('JORDAN'),
  legalMiddleName: sure(null),
  legalLastName: sure('SAMPLETON'),
  dateOfBirth: sure('1988-03-14'),
  cdlNumber: sure('S123456789'),
  issuingState: sure('IL'),
  cdlClass: sure('A'),
  endorsements: sure([]),
  restrictions: sure([]),
  cdlIssuedOn: sure('2024-06-01'),
  cdlExpiresOn: sure('2028-06-01'),
};

function service(application: unknown) {
  const hiring = { row: vi.fn().mockResolvedValue({ id: 'hc_1', driverId: 'drv_1', candidateName: 'Jordan Sampleton' }) };
  const compliance = { upload: vi.fn() };
  const applications = {
    get: vi.fn(async () => {
      if (application instanceof Error) throw application;
      return application;
    }),
  };
  const muse = { readJson: vi.fn().mockResolvedValue({ data: card, model: 'muse-spark-1.3', ms: 7000, usage: {} }) };
  return {
    svc: new HiringDocumentsService(
      hiring as unknown as HiringService,
      compliance as unknown as ComplianceService,
      applications as unknown as DotApplicationsService,
      muse as unknown as MuseVisionService,
    ),
    compliance,
    muse,
  };
}

const file = { fileName: 'cdl.png', contentType: 'image/png' as const, content: 'iVBORw0KGgo=' };

describe('HiringDocumentsService.readCdl', () => {
  it('flags a date of birth that differs from the application, and writes nothing', async () => {
    const { svc, compliance } = service({
      form: { legalFirstName: 'Jordan', legalLastName: 'Sampleton', dateOfBirth: '1988-03-15', licenses: [] },
    });
    const result = await svc.readCdl(principal, 'hc_1', file, new Date('2026-11-03T15:00:00Z'));
    expect(result.model).toBe('muse-spark-1.3');
    expect(result.compared).toBe(true);
    expect(result.extract).toMatchObject({ cdlExpiresOn: '2028-06-01', source: 'ocr' });
    expect(result.warnings).toEqual([expect.objectContaining({ field: 'dateOfBirth', tone: 'warning' })]);
    expect(compliance.upload).not.toHaveBeenCalled();
  });

  it('reads a case from before the funnel without an application to compare with', async () => {
    const { svc } = service(new AppError({ status: 409, title: 'Conflict' }));
    const result = await svc.readCdl(principal, 'hc_1', file);
    expect(result.compared).toBe(false);
  });
});

describe('HiringDocumentsService.upload with a confirmed reading', () => {
  it('keeps the reading on a CDL and ignores it on any other paper', async () => {
    const { svc, compliance } = service(null);
    compliance.upload.mockResolvedValue({ document: { id: 'doc_1' } });
    const base = { title: 'CDL', fileName: 'cdl.png', contentType: 'image/png', sizeBytes: 8, issuedOn: null, expiresOn: '2028-06-01', notes: null, content: 'iVBORw0KGgo=' };
    const extracted = { cdlNumber: 'S123456789', cdlExpiresOn: '2028-06-01', source: 'ocr' as const };
    await svc.upload(principal, 'hc_1', { ...base, requirementCode: 'cdl', extracted } as never);
    expect(compliance.upload.mock.calls[0]![1].extracted).toMatchObject({ cdlNumber: 'S123456789', source: 'ocr', needsReview: [] });
    await svc.upload(principal, 'hc_1', { ...base, requirementCode: 'medical_card', extracted } as never);
    expect(compliance.upload.mock.calls[1]![1].extracted).toBeUndefined();
  });
});
