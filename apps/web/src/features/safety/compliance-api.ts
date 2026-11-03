import type {
  ComplianceAuditEntry,
  ComplianceDocument,
  ComplianceDocumentStatus,
  ComplianceOwnerType,
  ComplianceScope,
  ConsentPurpose,
  ConsentRequest,
  ConsentStatus,
  QualificationItem,
  QualificationRequirement,
  UploadComplianceDocumentInput,
  VerificationCase,
  VerificationDecision,
  VerificationStage,
} from '@neway/shared';
import { apiDelete, apiGet, apiPost } from '@/lib/api-client';

/**
 * The qualification file over HTTP.
 *
 * Function for function, this is the surface the browser demo layer used to provide from memory —
 * same names, same shapes — so the Safety screens changed an import path and nothing else. What
 * changed underneath is that the file now lives in PostgreSQL: a decision recorded on Tuesday is
 * still there on Wednesday, and the hiring funnel reads the same rows.
 */

const BASE = '/compliance';

export interface ComplianceQuery {
  scope?: ComplianceScope;
  entityId?: string;
}

export interface ComplianceDocumentQuery {
  ownerType?: ComplianceOwnerType;
  ownerId?: string;
  requirementCode?: string;
  status?: ComplianceDocumentStatus;
}

export interface ConsentQuery {
  driverId?: string;
  status?: ConsentStatus;
  purpose?: ConsentPurpose;
}

export interface VerificationQuery {
  stage?: VerificationStage;
  ownerId?: string;
  driverId?: string;
}

export interface AuditQuery {
  entityId?: string;
  limit?: number;
}

export function listComplianceRequirements(): Promise<QualificationRequirement[]> {
  return apiGet(`${BASE}/requirements`);
}

export function listQualificationItems(query: ComplianceQuery = {}): Promise<QualificationItem[]> {
  return apiGet(`${BASE}/items`, { ...query });
}

export function waiveQualificationItem(
  id: string,
  input: { until: string; reason: string },
): Promise<QualificationItem> {
  return apiPost(`${BASE}/items/${id}/waive`, input);
}

export function listComplianceDocuments(
  query: ComplianceDocumentQuery = {},
): Promise<ComplianceDocument[]> {
  return apiGet(`${BASE}/documents`, { ...query });
}

export function uploadComplianceDocument(
  input: UploadComplianceDocumentInput,
): Promise<{ document: ComplianceDocument; item: QualificationItem }> {
  return apiPost(`${BASE}/documents`, input);
}

export function verifyComplianceDocument(id: string): Promise<ComplianceDocument> {
  return apiPost(`${BASE}/documents/${id}/verify`, {});
}

export function rejectComplianceDocument(
  id: string,
  input: { reason: string },
): Promise<ComplianceDocument> {
  return apiPost(`${BASE}/documents/${id}/reject`, input);
}

/** Removes the document and its file; the requirement it backed reads as missing again. */
export function deleteComplianceDocument(id: string): Promise<{ id: string }> {
  return apiDelete(`${BASE}/documents/${id}`);
}

export function listConsentRequests(query: ConsentQuery = {}): Promise<ConsentRequest[]> {
  return apiGet(`${BASE}/consents`, { ...query });
}

export function createConsentRequest(input: {
  driverId: string;
  purpose: ConsentPurpose;
}): Promise<ConsentRequest> {
  return apiPost(`${BASE}/consents`, input);
}

export function sendConsentRequest(id: string): Promise<ConsentRequest> {
  return apiPost(`${BASE}/consents/${id}/send`, {});
}

export function cancelConsentRequest(id: string): Promise<ConsentRequest> {
  return apiPost(`${BASE}/consents/${id}/cancel`, {});
}

/**
 * The driver's side of a consent, recorded from the desk. There is no driver portal yet; until
 * there is, this is how a view, signature or refusal enters the system.
 */
export function respondToConsentRequest(
  id: string,
  input: { outcome: 'viewed' | 'signed' | 'declined'; signerName?: string },
): Promise<ConsentRequest> {
  return apiPost(`${BASE}/consents/${id}/respond`, input);
}

export function listVerificationCases(query: VerificationQuery = {}): Promise<VerificationCase[]> {
  return apiGet(`${BASE}/verification`, { ...query });
}

export function getVerificationCase(id: string): Promise<VerificationCase> {
  return apiGet(`${BASE}/verification/${id}`);
}

export function recordVerificationDecision(
  id: string,
  input: { decision: VerificationDecision; conditions: string[]; note: string | null },
): Promise<VerificationCase> {
  return apiPost(`${BASE}/verification/${id}/decision`, input);
}

/** Safety picks the case up (audited). An approval is refused until this has happened. */
export function startVerificationReview(id: string): Promise<VerificationCase> {
  return apiPost(`${BASE}/verification/${id}/start-review`, {});
}

/** Newest first. `limit` defaults to 50. */
export function listComplianceAudit(query: AuditQuery = {}): Promise<ComplianceAuditEntry[]> {
  return apiGet(`${BASE}/audit`, { ...query });
}
