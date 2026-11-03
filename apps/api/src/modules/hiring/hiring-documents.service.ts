import { Injectable } from '@nestjs/common';
import {
  CDL_MUSE_INSTRUCTIONS,
  CdlExtractSchema,
  CdlMuseAnswerSchema,
  MAX_DOCUMENT_BYTES,
  WORK_AUTHORIZATION_CODE,
  cdlReadingFromAnswer,
  easternDate,
  type CdlApplicationFacts,
  type CdlReadResult,
  type ComplianceDocument,
  type HiringDocumentUploadRequest,
  type ReadCdlRequest,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { ComplianceService } from '../compliance/compliance.service';
import { MuseVisionService } from '../muse-vision/muse-vision.service';
import { DotApplicationsService } from './dot-applications.service';
import { HiringService } from './hiring.service';

/**
 * A candidate's papers, from HR's side (owner, 2026-09-29).
 *
 * HR collects the documents; Safety decides on them. So this reads and writes the driver's own
 * qualification file — the same records Safety's review queue shows — scoped to one hiring case,
 * which is what lets a recruiter without compliance access upload for their candidate and see
 * Safety's answer, and nothing else in the file. Every upload arrives "pending review".
 */
@Injectable()
export class HiringDocumentsService {
  constructor(
    private readonly hiring: HiringService,
    private readonly compliance: ComplianceService,
    private readonly applications: DotApplicationsService,
    private readonly muse: MuseVisionService,
  ) {}

  /** The driver file the case's documents go into; reserved when the DOT application is submitted. */
  private async driverOf(principal: Principal, caseId: string) {
    const row = await this.hiring.row(principal, caseId);
    return { row, driverId: row.driverId };
  }

  async list(principal: Principal, caseId: string): Promise<{ driverId: string | null; documents: ComplianceDocument[] }> {
    const { driverId } = await this.driverOf(principal, caseId);
    if (!driverId) return { driverId: null, documents: [] };
    const documents = await this.compliance.listDocuments(principal, { ownerType: 'driver', ownerId: driverId });
    return { driverId, documents };
  }

  async upload(principal: Principal, caseId: string, input: HiringDocumentUploadRequest): Promise<ComplianceDocument> {
    const { row, driverId } = await this.driverOf(principal, caseId);
    if (!driverId) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Submit the DOT application first — it opens the driver file the documents go into.',
      });
    }
    const bytes = Buffer.from(input.content, 'base64');
    if (bytes.byteLength === 0) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'The uploaded file could not be decoded' });
    }
    if (bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new AppError({
        status: 413,
        title: 'Payload Too Large',
        detail: `A document may be at most ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB`,
      });
    }
    const { content: _content, workAuthorizationKind, extracted, ...rest } = input;
    const { document } = await this.compliance.upload(principal, {
      ...rest,
      // Which paper a Work authorization is (owner, 2026-10-26), kept on the document's reading.
      ...(input.requirementCode === WORK_AUTHORIZATION_CODE && workAuthorizationKind
        ? { extracted: CdlExtractSchema.parse({ workAuthorizationKind }) }
        : {}),
      // A licence reading the recruiter checked against the card (Read with Muse, 2026-11-03).
      ...(input.requirementCode === 'cdl' && extracted ? { extracted: CdlExtractSchema.parse(extracted) } : {}),
      ownerType: 'driver',
      ownerId: driverId,
      ownerLabel: row.candidateName,
      source: 'staff',
      bytes,
    });
    return document;
  }

  /**
   * Reads a licence with Meta Muse before it is uploaded (hackathon, 2026-11-03). Writes nothing:
   * the answer is a proposal the recruiter checks against the card, and only the upload they
   * confirm keeps it. Differences from the candidate's DOT application come back as warnings.
   */
  async readCdl(principal: Principal, caseId: string, input: ReadCdlRequest, now: Date = new Date()): Promise<CdlReadResult> {
    await this.driverOf(principal, caseId); // 404 for a case outside the company
    const application = await this.applicationFacts(principal, caseId);
    const result = await this.muse.readJson({
      file: input,
      schema: CdlMuseAnswerSchema,
      schemaName: 'cdl_reading',
      instructions: CDL_MUSE_INSTRUCTIONS,
      prompt: `Read this driver licence (${input.fileName}).`,
      companyId: principal.companyId,
    });
    return {
      ...cdlReadingFromAnswer(result.data, { application, today: easternDate(now) }),
      model: result.model,
      ms: result.ms,
    };
  }

  /** Name, date of birth and licences as the candidate typed them; null when there is no application. */
  private async applicationFacts(principal: Principal, caseId: string): Promise<CdlApplicationFacts | null> {
    let application;
    try {
      application = await this.applications.get(principal, caseId);
    } catch (error) {
      // A case from before the funnel has no candidate record and no application to compare with.
      if (error instanceof AppError && error.status === 409) return null;
      throw error;
    }
    if (!application) return null;
    const form = application.form;
    return {
      legalFirstName: form.legalFirstName || null,
      legalLastName: form.legalLastName || null,
      dateOfBirth: form.dateOfBirth && form.dateOfBirth !== '1900-01-01' ? form.dateOfBirth : null,
      licences: form.licenses.map((l) => ({ state: l.state, number: l.number, expiresOn: l.expiresOn || null })),
    };
  }

  /** One of the case's own documents, for preview; never another driver's. */
  async file(principal: Principal, caseId: string, documentId: string) {
    const { driverId } = await this.list(principal, caseId);
    const mine = driverId
      ? (await this.compliance.listDocuments(principal, { ownerType: 'driver', ownerId: driverId })).some((d) => d.id === documentId)
      : false;
    if (!mine) throw new AppError({ status: 404, title: 'Not Found', detail: `No document ${documentId} on this candidate` });
    return this.compliance.file(principal, documentId);
  }
}
