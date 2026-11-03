import { Check, ChevronDown, Copy, Download, Eye, FileText, MoreHorizontal, Upload } from 'lucide-react';
import { useState } from 'react';
import {
  HIRING_DOCUMENTS,
  RECRUIT_PROGRESS_LABELS,
  hiringDocumentState,
  type ComplianceDocument,
  type HiringCase,
  type RecruitCandidate,
  type RecruitNote,
} from '@neway/shared';
import { Alert, Button, DatePicker, DropdownMenu, FormField, MenuItem, MenuSeparator, Modal, Textarea, cn, useToast } from '@/design-system';
import { ReceiptPreview } from '@/features/accounting/ReceiptPreview';
import { ApiError } from '@/lib/api-client';
import { copyText } from '@/lib/clipboard';
import { UploadCandidateDocument } from '../CandidateHiringParts';
import { StagedDriverFiles } from '../DotLinkPanel';
import { caseDocumentFileUrl, useCaseDocuments } from '../useHiring';
import { PersonChip, ProgressBadge, QuietState } from './RecruitKit';
import { downloadAuthed, longDate } from './recruit-format';
import { DriverApplicationPanel } from './DriverApplicationParts';
import { statusRows } from './status-rows';
import { driverApplicationUrls, recruitApi, useRecruiters, useRecruitMutation } from './useRecruit';

/**
 * The candidate page's controls, drawn to the approved mockup (owner, 2026-10-08): the assignee
 * as an avatar and first name, the status badge that opens the steps, the reminder, the ⋯ on a
 * note, and the Documents tab with the full application beside it.
 */

// ------------------------------------------------------------------------------ assigned to

export function AssigneeMenu({ candidate }: { candidate: RecruitCandidate }) {
  const { toast } = useToast();
  const recruiters = useRecruiters(candidate.permissions.canReassign);
  const reassign = useRecruitMutation((employeeId: string | null) => recruitApi.reassign(candidate.key, employeeId));
  const current = candidate.recruiter;
  const label = <span className="text-sm text-nw-text-3">Assigned to</span>;
  if (!candidate.permissions.canReassign) {
    return (
      <span className="flex items-center gap-2.5" data-testid="assignee">
        {label}
        <PersonChip name={current?.name ?? null} />
      </span>
    );
  }
  const options = [...(recruiters.data ?? [])];
  if (current && !options.some((r) => r.employeeId === current.employeeId)) options.unshift(current);
  const pick = (employeeId: string | null) =>
    reassign.mutate(employeeId, {
      onSuccess: (r) => toast({ tone: 'success', title: r.recruiter ? `Assigned to ${r.recruiter.name}` : 'Unassigned' }),
      onError: (e) => toast({ tone: 'danger', title: 'Not reassigned', description: e instanceof ApiError ? e.message : undefined }),
    });
  return (
    <span className="flex items-center gap-2.5" data-testid="assignee">
      {label}
      <DropdownMenu
        align="end"
        trigger={
          <button
            type="button"
            aria-label={`Assigned to ${current?.name ?? 'nobody'} — change`}
            disabled={reassign.isPending}
            className="flex items-center gap-1.5 rounded-[9px] px-1.5 py-1 transition-colors duration-150 hover:bg-nw-hover focus-visible:outline-2 focus-visible:outline-nw-accent motion-reduce:transition-none"
          >
            <PersonChip name={current?.name ?? null} />
            <ChevronDown aria-hidden className="size-4 text-nw-text-3" />
          </button>
        }
      >
        {options.map((r) => (
          <MenuItem key={r.employeeId} icon={r.employeeId === current?.employeeId ? <Check /> : <span className="size-4" />} onSelect={() => r.employeeId !== current?.employeeId && pick(r.employeeId)}>
            {r.name}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={!current ? <Check /> : <span className="size-4" />} onSelect={() => current && pick(null)}>
          Nobody
        </MenuItem>
      </DropdownMenu>
    </span>
  );
}

// ---------------------------------------------------------------------------- status menu

import type { StatusAction } from './status-rows';
export type { StatusAction };

export function StatusMenu({
  candidate,
  canDropCase,
  onAction,
}: {
  candidate: RecruitCandidate;
  canDropCase: boolean;
  onAction: (a: StatusAction) => void;
}) {
  if (!candidate.permissions.canManage) return <ProgressBadge progress={candidate.progress} nextStep={candidate.nextStep} />;
  const rows = statusRows(candidate, canDropCase);
  return (
    <DropdownMenu
      align="end"
      trigger={
        <button
          type="button"
          aria-label={`Status: ${RECRUIT_PROGRESS_LABELS[candidate.progress]} — change`}
          className="rounded-[10px] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-nw-accent"
          data-testid="status-menu"
        >
          <ProgressBadge progress={candidate.progress} nextStep={candidate.nextStep} className="cursor-pointer transition-[filter] hover:brightness-[0.97]" />
        </button>
      }
      className="w-80"
    >
      {rows.map((r, i) => (
        <div key={r.progress}>
          {i === rows.length - 1 ? <MenuSeparator /> : null}
          <MenuItem
            data-testid={`status-${r.progress}`}
            aria-current={r.progress === candidate.progress ? 'step' : undefined}
            disabled={!r.enabled}
            destructive={r.progress === 'closed' && r.enabled}
            icon={r.progress === candidate.progress ? <Check className="text-nw-accent" /> : <span className="size-4" />}
            onSelect={() => r.action && onAction(r.action)}
          >
            <span className="flex flex-col whitespace-normal">
              <span className={cn('font-medium', r.progress === candidate.progress && 'text-nw-accent-ink')}>{r.label ?? RECRUIT_PROGRESS_LABELS[r.progress]}</span>
              {r.hint ? <span className="text-xs text-nw-text-3">{r.hint}</span> : null}
            </span>
          </MenuItem>
        </div>
      ))}
    </DropdownMenu>
  );
}

// -------------------------------------------------------------------------------- reminder

/**
 * Send reminder: a message to copy and send yourself, and an optional follow-up date saved as a
 * note. Nothing is sent from here, and the dialog never says it was.
 */
export function ReminderModal({ candidate, onClose, onNewLink }: { candidate: RecruitCandidate; onClose: () => void; onNewLink: () => void }) {
  const { toast } = useToast();
  const first = candidate.name.split(/\s+/)[0] ?? candidate.name;
  const awaiting = candidate.progress === 'application_sent';
  const [message, setMessage] = useState(
    awaiting
      ? `Hi ${first}! Just a reminder to finish your driver application with us — it only takes a few minutes. Reply here if you need the link again.`
      : `Hi ${first}! Following up about driving with us. Do you have a few minutes to talk about the position?`,
  );
  const [followUpOn, setFollowUpOn] = useState('');
  const save = useRecruitMutation((on: string) => recruitApi.addNote(candidate.key, { note: `Reminder sent by hand: ${message}`, followUpOn: on || null }));
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Send reminder"
      description="Copy the message and send it from your phone or inbox. Nothing is sent from here."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
          <Button
            variant="primary"
            loading={save.isPending}
            onClick={() =>
              save.mutate(followUpOn, {
                onSuccess: () => {
                  toast({ tone: 'success', title: 'Noted', description: followUpOn ? `Follow-up set for ${longDate(followUpOn)}.` : 'Saved on the Notes tab.' });
                  onClose();
                },
              })
            }
          >
            I sent it — save a note
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="reminder-dialog">
        <FormField label="Message">
          <Textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} />
        </FormField>
        <div className="flex flex-wrap gap-2">
          <Button
            variant="outline"
            icon={<Copy />}
            onClick={() =>
              void copyText(message).then(
                () => toast({ tone: 'success', title: 'Message copied', description: 'Copied to your clipboard. Nothing was sent.' }),
                () => toast({ tone: 'warning', title: 'Copy is not available here' }),
              )
            }
            data-testid="copy-reminder"
          >
            Copy message
          </Button>
          {candidate.permissions.canManage ? (
            <Button variant="ghost" onClick={onNewLink}>
              Need the link? Make one
            </Button>
          ) : null}
        </div>
        <FormField label="Follow-up date (optional)">
          <DatePicker aria-label="Follow-up date" value={followUpOn || null} onIsoChange={setFollowUpOn} placeholder="Select date" />
        </FormField>
        {save.error ? <Alert tone="danger" title="Not saved" description={save.error instanceof ApiError ? save.error.message : 'Try again.'} /> : null}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------- note ⋯ menu

/** Notes are append-only audit entries: the ⋯ offers what that allows, and says so. */
export function NoteMenu({ note }: { note: RecruitNote }) {
  const { toast } = useToast();
  return (
    <DropdownMenu
      align="end"
      trigger={
        <button type="button" aria-label="Note actions" className="rounded-md p-1 text-nw-text-3 hover:bg-nw-hover hover:text-nw-text" data-testid="note-menu">
          <MoreHorizontal className="size-5" />
        </button>
      }
    >
      <MenuItem
        icon={<Copy />}
        onSelect={() =>
          void copyText(note.text ?? note.summary ?? '').then(
            () => toast({ tone: 'success', title: 'Note copied' }),
            () => toast({ tone: 'warning', title: 'Copy is not available here' }),
          )
        }
      >
        Copy text
      </MenuItem>
      <MenuItem disabled>
        <span className="flex flex-col whitespace-normal">
          <span>Notes are kept as written</span>
          <span className="text-xs text-nw-text-3">To correct one, add a new note.</span>
        </span>
      </MenuItem>
    </DropdownMenu>
  );
}

// ------------------------------------------------------------------------------- documents

const BEFORE_HIRE_INTAKE = ['cdl', 'cdl_back', 'medical_card'];

export function DocumentsTab({
  candidate: c,
  hiringCase,
  summary,
}: {
  candidate: RecruitCandidate;
  hiringCase: HiringCase;
  summary: React.ReactNode;
}) {
  const { toast } = useToast();
  const docs = useCaseDocuments(hiringCase.id);
  const [uploading, setUploading] = useState<{ code: string; label: string } | null>(null);
  const [viewing, setViewing] = useState<ComplianceDocument | null>(null);
  const canEdit = c.permissions.canManage;
  const documents = docs.data?.documents ?? [];
  const latest = new Map<string, ComplianceDocument>();
  for (const d of [...documents].sort((a, b) => a.uploadedAt.localeCompare(b.uploadedAt))) latest.set(d.requirementCode, d);
  const uploaded = [...latest.values()].filter((d) => d.requirementCode !== 'dot_application');
  // What Recruiting collects that is still missing: the intake papers, then the rest needed before hire.
  const missing = HIRING_DOCUMENTS.filter(
    (d) => d.code !== 'dot_application' && (BEFORE_HIRE_INTAKE.includes(d.code) || d.timing === 'before_hire') && hiringDocumentState(documents, d.code) === 'missing',
  );
  const pdf = c.application.documentId;
  const driverApp = c.driverApplication.submission;

  return (
    <div className="grid grid-cols-1 gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]" data-testid="documents-tab">
      <div className="flex flex-col gap-4">
        <section className="rounded-xl border border-nw-border bg-nw-panel">
          <h2 className="px-4 pt-3.5 pb-2 text-sm font-semibold text-nw-text">Uploaded documents</h2>
          {docs.isPending ? (
            <p className="px-4 pb-4 text-sm text-nw-text-3">Loading…</p>
          ) : docs.error ? (
            <p className="px-4 pb-4 text-sm text-nw-urgent-text">The documents could not be loaded.</p>
          ) : !docs.data?.driverId ? (
            <div className="px-4 pb-4">
              <p className="text-sm text-nw-text-3">No driver file yet — it opens when the application is accepted.</p>
              <StagedDriverFiles caseId={hiringCase.id} />
            </div>
          ) : uploaded.length === 0 ? (
            <p className="px-4 pb-4 text-sm text-nw-text-3">Nothing uploaded yet.</p>
          ) : (
            <ul className="flex flex-col gap-2 px-3 pb-3">
              {uploaded.map((d) => {
                const state = hiringDocumentState(documents, d.requirementCode);
                return (
                  <li key={d.id} className="flex items-center gap-3 rounded-[10px] border border-nw-border px-3 py-2.5" data-testid={`uploaded-${d.requirementCode}`}>
                    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-nw-done-bg text-nw-done-icon">
                      <FileText aria-hidden className="size-4" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold text-nw-text">{d.title}</span>
                      <span className="block text-xs break-words text-nw-text-3" data-testid={`uploaded-status-${d.requirementCode}`}>
                        Uploaded {longDate(d.uploadedAt)} · {state === 'approved' ? 'Approved by Safety' : state === 'rejected' ? 'Rejected by Safety' : state === 'expired' ? 'Expired' : 'Pending review'}
                      </span>
                    </span>
                    <Button variant="outline" size="sm" icon={<Eye />} onClick={() => setViewing(d)}>
                      View
                    </Button>
                    <DropdownMenu
                      align="end"
                      trigger={
                        <button type="button" aria-label={`${d.title} actions`} className="rounded-md p-1 text-nw-text-3 hover:bg-nw-hover hover:text-nw-text">
                          <MoreHorizontal className="size-5 rotate-90" />
                        </button>
                      }
                    >
                      <MenuItem icon={<Download />} onSelect={() => void downloadAuthed(caseDocumentFileUrl(hiringCase.id, d.id), d.fileName).catch(() => toast({ tone: 'danger', title: 'The file could not be downloaded' }))}>
                        Download
                      </MenuItem>
                      {canEdit ? (
                        <MenuItem icon={<Upload />} onSelect={() => setUploading({ code: d.requirementCode, label: d.title })}>
                          Upload a newer one
                        </MenuItem>
                      ) : null}
                    </DropdownMenu>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        {docs.data?.driverId && missing.length > 0 ? (
          <section className="rounded-xl border border-nw-border bg-nw-panel">
            <h2 className="px-4 pt-3.5 pb-2 text-sm font-semibold text-nw-text">Additional documents</h2>
            <ul className="flex flex-col gap-2 px-3 pb-3">
              {missing.map((d) => (
                <li key={d.code} className="flex items-center gap-3 rounded-[10px] border border-nw-warning-border bg-nw-warning-bg px-3 py-2.5" data-testid={`missing-${d.code}`}>
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-nw-panel text-nw-warning-icon">
                    <FileText aria-hidden className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-nw-text">{d.label}</span>
                    <span className="block text-xs text-nw-warning-text">Not yet uploaded</span>
                  </span>
                  {canEdit ? (
                    <Button variant="outline" size="sm" icon={<Upload />} onClick={() => setUploading({ code: d.code, label: d.label })}>
                      Upload
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {summary}
      </div>

      <section className="flex max-h-[760px] flex-col rounded-xl border border-nw-border bg-nw-panel" data-testid="full-application-panel">
        <header className="flex items-center justify-between gap-3 border-b border-nw-border px-4 py-3">
          <h2 className="text-sm font-semibold text-nw-text">Full application</h2>
          {driverApp ? (
            <Button
              variant="outline"
              size="sm"
              icon={<Download />}
              data-testid="driver-application-pdf"
              onClick={() =>
                void downloadAuthed(driverApplicationUrls.applicationPdf(c.key), `driver-application-${driverApp.reference}.pdf`).catch(() =>
                  toast({ tone: 'danger', title: 'The application could not be downloaded' }),
                )
              }
            >
              Download PDF
            </Button>
          ) : pdf ? (
            <Button
              variant="outline"
              size="sm"
              icon={<Download />}
              onClick={() => void downloadAuthed(caseDocumentFileUrl(hiringCase.id, pdf), `application-${c.applicantNumber ?? c.key}.pdf`).catch(() => toast({ tone: 'danger', title: 'The application could not be downloaded' }))}
            >
              Download
            </Button>
          ) : null}
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto p-4">
          {driverApp ? (
            <div className="flex flex-col gap-6">
              <DriverApplicationPanel candidate={c} />
              {c.application.summary ? (
                <div className="flex flex-col gap-3 border-t border-nw-border pt-4" data-testid="dot-application-under-driver">
                  {pdf ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={<Download />}
                      className="self-start"
                      onClick={() => void downloadAuthed(caseDocumentFileUrl(hiringCase.id, pdf), `application-${c.applicantNumber ?? c.key}.pdf`).catch(() => toast({ tone: 'danger', title: 'The application could not be downloaded' }))}
                    >
                      Download the DOT application (PDF)
                    </Button>
                  ) : null}
                  <FullApplication candidate={c} />
                </div>
              ) : (
                <p className="border-t border-nw-border pt-3 text-xs text-nw-text-3">The full DOT employment application is separate: More › Full DOT application.</p>
              )}
            </div>
          ) : c.application.summary ? (
            <FullApplication candidate={c} />
          ) : (
            <QuietState title="No application on file yet" description="It shows here once the driver submits it." />
          )}
        </div>
      </section>

      {uploading ? <UploadCandidateDocument caseId={hiringCase.id} code={uploading.code} label={uploading.label} onClose={() => setUploading(null)} /> : null}
      {viewing ? (
        <Modal
          open
          onOpenChange={(o) => !o && setViewing(null)}
          title={viewing.title}
          size="lg"
          footer={
            <Button variant="secondary" onClick={() => setViewing(null)}>
              Back to candidate
            </Button>
          }
        >
          <div className="nw-paper">
            <ReceiptPreview url={caseDocumentFileUrl(hiringCase.id, viewing.id)} fileName={viewing.fileName} />
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

function FullApplication({ candidate: c }: { candidate: RecruitCandidate }) {
  const s = c.application.summary;
  if (!s) return null;
  const rows = (pairs: [string, string | null][]) => (
    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] gap-x-4 gap-y-1.5 text-[13px]">
      {pairs.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="text-nw-text-3">{k}</dt>
          <dd className="break-words text-nw-text">{v ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
  return (
    <article className="flex flex-col gap-4" data-testid="full-application">
      <h3 className="text-[15px] font-semibold text-nw-text">DOT employment application</h3>
      <section className="flex flex-col gap-2 border-b border-nw-border pb-4">
        <h4 className="text-[13px] font-semibold text-nw-text">Personal Information</h4>
        {rows([
          ['Full name', s.personal.legalName],
          ['Date of birth', longDate(s.personal.dateOfBirth)],
          ['Phone', c.phone],
          ['Email', c.email],
          ['Address', s.personal.currentAddress],
          ['SSN', s.personal.ssnMasked],
        ])}
      </section>
      <section className="flex flex-col gap-2 border-b border-nw-border pb-4">
        <h4 className="text-[13px] font-semibold text-nw-text">CDL & Experience</h4>
        {rows([
          ['CDL class', s.cdl.licenseClass ? `Class ${s.cdl.licenseClass}` : null],
          ['CDL number', s.cdl.numberMasked],
          ['State', s.cdl.state],
          ['Expires', longDate(s.cdl.expiresOn)],
          ['Endorsements', s.cdl.endorsements.join(', ') || 'None'],
          ['Employers listed', `${s.experience.employers} (${s.experience.cmvEmployers} driving)`],
          ['Most recent', s.experience.mostRecent ? `${s.experience.mostRecent.employer} · ${s.experience.mostRecent.position}` : null],
        ])}
      </section>
      <section className="flex flex-col gap-2">
        <h4 className="text-[13px] font-semibold text-nw-text">Certification</h4>
        {rows([
          ['Certified by', s.certifiedName],
          ['On', longDate(s.certifiedOn)],
        ])}
      </section>
    </article>
  );
}
