import type { AuthAccount, LoginResponse } from '@neway/shared/auth/index';
import type { DocumentLike, LoadDocumentType, LoadLike, LoadStatusCode, StopLike } from '@neway/shared/loads/model';
import type { DeepLinkType, DriverLoadScope, OfficeApprovalKind, OfficeDispatchTab, OfficeRole } from '@neway/shared/mobile/index';

/**
 * The routes the phone calls (docs/mobile/API.md, PLAN.md §D) and their shapes.
 *
 * Every shape is the server's own contract from packages/shared (types only); nothing here
 * describes a response the phone would have to guess. Office workspaces reuse the existing TMS
 * routes (PTI board, billing queue, reimbursements, breakdowns, my leads), typed below with the
 * fields the phone reads.
 */
export type * from '@neway/shared/mobile/index';
export type { AuthAccount, LoginResponse, LoadLike, StopLike, DocumentLike, LoadStatusCode, LoadDocumentType };
export type { PtiBoard, PtiBoardRow, PtiInspection, PtiDefect } from '@neway/shared/fleet/pti';

export type MeResponse = AuthAccount & { signedIn: boolean };

/** Upload headers of POST /driver/loads/:id/documents (DRIVER_UPLOAD_HEADERS in shared). */
export const UPLOAD_HEADERS = {
  docType: 'x-doc-type',
  stopId: 'x-stop-id',
  pageCount: 'x-page-count',
  replacesId: 'x-replaces-id',
} as const;

const e = encodeURIComponent;
const q = (params: Record<string, string | null | undefined>) => {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${e(v!)}`);
  return parts.length ? `?${parts.join('&')}` : '';
};

export const routes = {
  login: '/auth/login',
  me: '/auth/me',
  logout: '/auth/logout',
  switchCompany: '/auth/switch-company',
  temporaryPassword: '/auth/password/temporary',

  // ---------------------------------------------------------------- driver (M1)
  driverMe: '/driver/me',
  driverLoads: (scope: DriverLoadScope) => `/driver/loads?scope=${scope}`,
  driverLoad: (id: string) => `/driver/loads/${e(id)}`,
  driverLoadAck: (id: string) => `/driver/loads/${e(id)}/ack`,
  driverStopEvent: (id: string) => `/driver/loads/${e(id)}/stop-event`,
  driverLoadDocuments: (id: string) => `/driver/loads/${e(id)}/documents`,
  driverFiles: '/driver/files',
  driverFileLink: (id: string) => `/driver/files/${e(id)}/link`,
  driverPtiCurrent: '/driver/pti/current',
  driverPti: '/driver/pti',

  // ---------------------------------------------------------------- driver (M3)
  driverBreakdowns: '/driver/breakdowns',
  driverBreakdown: (id: string) => `/driver/breakdowns/${e(id)}`,
  driverReimbursements: '/driver/reimbursements',
  driverReimbursement: (id: string) => `/driver/reimbursements/${e(id)}`,
  driverSettlements: (week?: string | null) => `/driver/settlements${q({ week })}`,
  driverSettlement: (id: string) => `/driver/settlements/${e(id)}`,
  driverSettlementPdf: (id: string) => `/driver/settlements/${e(id)}/pdf`,
  driverCare: '/driver/care',
  driverCareRequest: (id: string) => `/driver/care/${e(id)}`,
  driverReferrals: '/driver/referrals',
  driverVacations: '/driver/vacations',
  driverVacationParked: (id: string) => `/driver/vacations/${e(id)}/parked`,
  driverVacationCancel: (id: string) => `/driver/vacations/${e(id)}/cancel`,
  driverDocuments: '/driver/documents',
  driverSafetyReports: '/driver/safety-reports',
  driverSafetyReport: (id: string) => `/driver/safety-reports/${e(id)}`,
  driverAssistantAsk: '/driver/assistant/ask',
  driverAssistantTranscribe: '/driver/assistant/transcribe',
  /** Ask by voice (Meta Muse): WAV in, the words heard and the answer out. */
  driverAssistantVoice: '/driver/assistant/voice',

  // ---------------------------------------------------------------- driver messages (M4)
  driverConversations: '/driver/conversations',
  driverConversationMessages: (id: string) => `/driver/conversations/${e(id)}/messages`,
  driverConversationRead: (id: string) => `/driver/conversations/${e(id)}/read`,
  driverConversationFile: (id: string, fileId: string) => `/driver/conversations/${e(id)}/files/${e(fileId)}/link`,

  // ---------------------------------------------------------------- every signed-in person
  devices: '/mobile/devices',
  deviceRevoke: (id: string) => `/mobile/devices/${e(id)}/revoke`,
  notifications: '/mobile/notifications?limit=100',
  notificationsHead: '/mobile/notifications?limit=1',
  notificationRead: (id: string) => `/mobile/notifications/${e(id)}/read`,
  notificationsReadAll: '/mobile/notifications/read-all',

  // ---------------------------------------------------------------- office (M4)
  officeMe: '/office/me',
  officeToday: (role: OfficeRole, period?: string | null) => `/office/today${q({ role, period })}`,
  officeDispatch: (tab: OfficeDispatchTab, query?: string) => `/office/dispatch${q({ tab, q: query })}`,
  officeApprovals: (kind?: OfficeApprovalKind | null) => `/office/approvals${q({ kind })}`,
  officeMyWork: '/office/my-work',
  ptoMe: '/hr/pto/me',
  conversations: (scope?: string | null, department?: string | null) => `/conversations${q({ scope, department })}`,
  startConversation: '/conversations',
  conversationMessages: (id: string) => `/conversations/${e(id)}/messages`,
  conversationRead: (id: string) => `/conversations/${e(id)}/read`,
  conversationFile: (id: string, fileId: string) => `/conversations/${e(id)}/files/${e(fileId)}/link`,
  filesRaw: '/files/raw',
  fileLink: (id: string) => `/files/${e(id)}/link`,

  // existing office routes the workspaces reuse
  loads: '/loads',
  load: (id: string) => `/loads/${e(id)}`,
  loadStatus: (id: string) => `/loads/${e(id)}/status`,
  ptiBoard: '/fleet/pti/board',
  ptiInspection: (id: string) => `/fleet/pti/inspections/${e(id)}`,
  ptiReview: (id: string) => `/fleet/pti/inspections/${e(id)}/review`,
  ptiRequestCorrection: (id: string) => `/fleet/pti/inspections/${e(id)}/request-correction`,
  fleetBreakdowns: (open?: boolean) => `/fleet/breakdowns${q({ open: open === undefined ? null : String(open) })}`,
  fleetBreakdown: (id: string) => `/fleet/breakdowns/${e(id)}`,
  fleetBreakdownShops: '/fleet/breakdowns/shops',
  fleetBreakdownPeople: '/fleet/breakdowns/people',
  fleetBreakdownAssign: (id: string) => `/fleet/breakdowns/${e(id)}/assign`,
  fleetBreakdownShop: (id: string) => `/fleet/breakdowns/${e(id)}/shop`,
  fleetBreakdownWorkOrder: (id: string) => `/fleet/breakdowns/${e(id)}/work-order`,
  fleetBreakdownStatus: (id: string) => `/fleet/breakdowns/${e(id)}/status`,
  billingQueue: '/accounting/billing/queue',
  billingDocumentReview: (loadId: string, documentId: string) => `/accounting/billing/loads/${e(loadId)}/documents/${e(documentId)}/review`,
  reimbursements: (status?: string | null) => `/accounting/reimbursements${q({ status })}`,
  reimbursementReview: (id: string) => `/accounting/reimbursements/${e(id)}/review`,
  settlements: '/accounting/settlements',
  myLeads: '/hiring/my-leads',
  leadNotes: (id: string) => `/hiring/leads/${e(id)}/notes`,
} as const;

/** The deep-link kinds a push or a notification row may carry (MobileNotification.target.type). */
export type { DeepLinkType };

export type { MyLeads, MyLeadRow, LeadNote } from '@neway/shared/hiring/activity';

// ------------------------------------------------- existing office routes: the fields the phone reads

/** GET /loads/:id (loads.view): the stored load plus display fields; money is never shown on the phone. */
export type OfficeLoad = LoadLike & {
  driverName?: string | null;
  truckUnit?: string | null;
  trailerUnit?: string | null;
  brokerReference?: string | null;
  customerName?: string | null;
  equipmentType?: string | null;
  commodity?: string | null;
  weightLbs?: number | null;
};

/** One row of GET /accounting/billing/queue. */
export interface BillingQueueRow {
  load: {
    id: string;
    loadNumber: string;
    status: string;
    brokerReference: string | null;
    customerName: string | null;
    brokerName: string | null;
    documents: Array<DocumentLike & { source?: string | null; fileId?: string | null; mimeType?: string | null; rejectedReason?: string | null; supersededBy?: string | null; stopId?: string | null }>;
    stops: Array<{ id: string; kind: string; status: string; facilityName: string; city: string; state: string }>;
    deliveredAt: string | null;
    updatedAt: string;
    driverName: string | null;
    truckUnit: string | null;
  };
  verdict: { loadId: string; queue: string; conditions: Array<{ code: string; message: string; fix?: string }> };
}

export interface BillingQueue {
  rows: BillingQueueRow[];
  counts: Record<string, number>;
}

/** One row of GET /accounting/reimbursements (an expense with its review block). */
export interface AccountingReimbursement {
  id: string;
  expenseNumber: string;
  description: string | null;
  amount: number;
  currency: string;
  onDate: string;
  driverName: string | null;
  loadNumber: string | null;
  unitNumber: string | null;
  receiptFileId: string | null;
  source: string;
  reimbursement: {
    status: string;
    category: string;
    receiptCents: number;
    driverFundedCents: number;
    paymentSource: string;
    payerDriverName: string | null;
    submittedAt: string | null;
    submittedBy: string | null;
    rejectedReason: string | null;
    note: string | null;
    settlementNumber: string | null;
  } | null;
}

/** One row of GET /accounting/settlements. */
export interface AccountingSettlement {
  id: string;
  settlementNumber: string;
  status: string;
  partyName: string;
  partyType: string;
  periodStart: string;
  periodEnd: string;
  payDate: string;
  netCents: number;
  payableCents: number;
  unitNumber: string | null;
  paidAt: string | null;
}

/** GET /fleet/breakdowns/shops and /people. */
export interface BreakdownShop {
  id: string;
  name: string;
  city: string | null;
  state: string | null;
}
export interface BreakdownPerson {
  id: string;
  name: string;
}
