import { accidentsV2 as A, safetyRules as R } from '@neway/shared';
import type { CompanyState } from './state.service';
import type { ViewerContext } from './views';

/**
 * Investigation read model (P4): parties, corrective actions, questions with owners and the evidence-reviewed
 * checklist — redacted for the viewer (witness contacts and restricted notes without accidents.restricted; a
 * disciplinary review is a lock card without accidents.discipline).
 */
export function investigationBlock(st: CompanyState, c: R.AccidentCase, ctx: ViewerContext): A.InvestigationBlock {
  const s = st.all;
  const canDiscipline = ctx.canDiscipline ?? ctx.canSeeRestricted;
  const rows = st.actionRows.get(c.id) ?? [];
  const submitMissing = [
    !c.investigation.conclusion?.trim() ? 'Write a conclusion' : null,
    c.determinations.fault.value === 'not_determined' ? 'Record driver fault' : null,
    c.determinations.preventability.value === 'not_determined' ? 'Record preventability' : null,
  ].filter((x): x is string => Boolean(x));
  return {
    vehicles: c.vehicles.map((v) => ({
      id: v.id,
      description: v.description,
      ownerName: v.owner || null,
      driverName: v.driver ?? null,
      insurer: v.insurer ?? null,
      policyNo: v.policyNo ?? null,
      plate: v.plate ?? null,
      damage: v.damage || null,
      towed: v.towed,
    })),
    witnesses: c.witnesses.map((w) => ({ id: w.id, name: w.name, contact: ctx.canSeeRestricted ? w.contact || null : null, note: w.note ?? null })),
    correctiveActions: c.correctiveActions.map((a) => {
      const row = rows.find((r) => r.id === a.id);
      const locked = Boolean(a.restricted) && !canDiscipline;
      return {
        id: a.id,
        number: row?.number ?? '',
        kind: a.kind,
        title: locked ? 'Restricted personnel action' : a.title,
        restricted: Boolean(a.restricted),
        locked,
        status: a.status,
        assignee: a.assigneeId ? { id: a.assigneeId, name: row?.assigneeName ?? R.personName(s, a.assigneeId) } : null,
        dueAt: a.due,
        completedAt: a.completedAt ?? null,
        evidence: locked ? null : (a.evidence ?? null),
        driverId: locked ? null : (a.driverId ?? null),
        version: row?.version ?? 1,
      };
    }),
    questions: c.investigation.questions.map((q) => ({
      id: q.id,
      text: q.text,
      owner: q.ownerId ? { id: q.ownerId, name: R.personName(s, q.ownerId) } : null,
      answer: q.answer ?? null,
      resolvedAt: q.resolvedAt ?? null,
      resolvedBy: q.resolvedBy ?? null,
    })),
    reviewItems: c.investigation.checklist.map((i) => ({ key: i.key, label: i.label, state: i.state, note: i.restricted && !ctx.canSeeRestricted ? null : (i.note ?? null), restricted: Boolean(i.restricted) })),
    submitMissing,
  };
}

const KIND = (contentType: string): A.EvidenceItem['kind'] =>
  contentType.startsWith('image/') ? 'photo' : contentType.startsWith('video/') ? 'video' : contentType === 'application/pdf' ? 'pdf' : 'doc';

/** One evidence item for the viewer: a lock card (category only) when it is restricted and the viewer may not see it. */
export function evidenceItem(
  doc: { id: string; title: string; description: string | null; category: string | null; kind: string; contentType: string; sizeBytes: number; uploadedBy: string; uploadedAt: Date; voidedAt: Date | null; voidedBy: string | null; voidReason: string | null; restricted: boolean; fileId: string; fileName: string; currentVersion: number; sha256: string | null },
  category: string,
  versions: { version: number; uploadedAt: Date; uploadedBy: string; note: string | null; fileId: string; fileName: string; sha256: string; sizeBytes: number }[],
  canSeeRestricted: boolean,
): A.EvidenceItem {
  const restricted = doc.restricted || (A.RESTRICTED_EVIDENCE as readonly string[]).includes(category);
  const locked = restricted && !canSeeRestricted;
  const all = versions.length
    ? [...versions].sort((a, b) => b.version - a.version)
    : [{ version: 1, uploadedAt: doc.uploadedAt, uploadedBy: doc.uploadedBy, note: 'Original upload', fileId: doc.fileId, fileName: doc.fileName, sha256: doc.sha256 ?? '', sizeBytes: doc.sizeBytes }];
  const latest = all[0];
  return {
    id: doc.id,
    category,
    restricted,
    locked,
    name: locked ? null : doc.title,
    description: locked ? null : doc.description,
    kind: KIND(doc.contentType),
    uploadedBy: locked ? null : doc.uploadedBy,
    uploadedAt: doc.uploadedAt.toISOString(),
    sizeKb: locked ? null : Math.round(doc.sizeBytes / 1024),
    version: Math.max(doc.currentVersion, latest?.version ?? 1),
    versions: locked ? null : all.map((v) => ({ v: v.version, at: v.uploadedAt.toISOString(), by: v.uploadedBy, note: v.note, fileId: v.fileId, fileName: v.fileName, sha256: v.sha256 || null, sizeBytes: v.sizeBytes })),
    removed: doc.voidedAt ? { at: doc.voidedAt.toISOString(), by: doc.voidedBy, reason: locked ? null : doc.voidReason } : null,
    fileId: locked ? null : (latest?.fileId ?? doc.fileId),
  };
}
