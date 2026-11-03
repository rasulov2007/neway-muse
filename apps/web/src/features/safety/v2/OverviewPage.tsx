import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  CalendarClock,
  ClipboardCheck,
  FileWarning,
  FlaskConical,
  OctagonAlert,
  Plus,
  ScanSearch,
  ShieldCheck,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { SafetyAttentionItem, SafetyCaseType } from '@neway/shared';
import { Button, StatusBadge } from '@/design-system';
import { useCan, useSafetyOverview } from './api';
import { AccidentForm } from './AccidentForm';
import { CountTile, DueText, LoadError, Loading, OwnerCell, Panel, SafetyTitle, td, th } from './ui';

/** Where a case opens. Drawer-based lists take `open`. */
function CaseLink({ type, id, children, className }: { type: SafetyCaseType; id: string; children: ReactNode; className?: string }) {
  const cls = className ?? 'font-semibold text-nw-accent-ink underline underline-offset-2';
  switch (type) {
    case 'accident':
      return <Link to="/safety/accidents/$accidentId" params={{ accidentId: id }} className={cls}>{children}</Link>;
    case 'claim':
      return <Link to="/safety/claims/$claimId" params={{ claimId: id }} className={cls}>{children}</Link>;
    case 'violation':
      return <Link to="/safety/violations" search={{ open: id } as never} className={cls}>{children}</Link>;
    case 'safety_review':
      return <Link to="/safety/review" search={{ open: id } as never} className={cls}>{children}</Link>;
    case 'roadside_inspection':
      return <Link to="/safety/inspections" className={cls}>{children}</Link>;
    case 'drug_test':
      return <Link to="/safety/compliance" className={cls}>{children}</Link>;
  }
}

const PROGRAM: { icon: ReactNode; title: string; text: string; to: string }[] = [
  { icon: <ClipboardCheck />, title: 'Compliance', text: 'Licenses, medicals, training and more.', to: '/safety/compliance' },
  { icon: <ScanSearch />, title: 'PTI & roadside inspections', text: 'Pre-trip, DOT and internal inspections.', to: '/safety/inspections' },
  { icon: <TriangleAlert />, title: 'Accidents', text: 'View and manage all accidents.', to: '/safety/accidents' },
  { icon: <ShieldCheck />, title: 'Claims', text: 'Insurance claims and recoveries.', to: '/safety/claims' },
  { icon: <FileWarning />, title: 'Violations', text: 'Company and regulatory violations.', to: '/safety/violations' },
  { icon: <FlaskConical />, title: 'Testing', text: 'Drug and alcohol testing.', to: '/safety/compliance' },
  { icon: <Users />, title: 'Driver reviews', text: 'MVRs, performance and safety reviews.', to: '/safety/review' },
];

/**
 * The Safety overview, as the owner's mockup draws it: five counts, the next action of every open
 * case in priority order, the open accident and claim files, and the programme. Every number is
 * the server's count of real records; test records are kept out.
 */
export function SafetyOverviewV2Page() {
  const overview = useSafetyOverview();
  const canWrite = useCan('safety.manage');
  const [recording, setRecording] = useState(false);
  const o = overview.data;
  return (
    <div className="flex w-full flex-col gap-4">
      {recording ? <AccidentForm open={recording} onOpenChange={setRecording} /> : null}
      <SafetyTitle
        title="Safety overview"
        subtitle="Everything your safety team needs to act on."
        actions={
          canWrite ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setRecording(true)}>
              Record incident
            </Button>
          ) : null
        }
      />
      {overview.error ? <LoadError error={overview.error} /> : null}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <CountTile icon={<OctagonAlert />} tone="urgent" value={o?.tiles.urgentTasks} label="Urgent tasks" hint="Require attention now." />
        <CountTile icon={<ClipboardCheck />} tone="moving" value={o?.tiles.openAccidents} label="Open accidents" hint="Active investigation or in progress." />
        <CountTile icon={<ShieldCheck />} tone="done" value={o?.tiles.activeClaims} label="Active claims" hint="Open with insurer." />
        <CountTile icon={<TriangleAlert />} tone="warning" value={o?.tiles.unresolvedViolations} label="Unresolved violations" hint="Require action." />
        <Link to="/safety/compliance" className="contents">
          <CountTile icon={<CalendarClock />} tone="accent" value={o?.tiles.complianceDue30} label="Compliance due" hint="Items due in next 30 days." />
        </Link>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)]">
        <div className="grid content-start gap-4">
          <Panel title="Needs attention" padding="none">
            {overview.isLoading ? <Loading /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[760px] border-collapse">
                  <thead className="border-b border-nw-border bg-nw-subtle">
                    <tr>
                      <th className={th}>Priority</th>
                      <th className={th}>Task</th>
                      <th className={th}>Driver &amp; truck</th>
                      <th className={th}>Owner</th>
                      <th className={th}>Due</th>
                      <th className={th}>Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-nw-border">
                    {(o?.needsAttention ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-10 text-center text-sm text-nw-text-3">
                          Nothing needs attention.
                        </td>
                      </tr>
                    ) : (
                      (o?.needsAttention ?? []).slice(0, 15).map((item: SafetyAttentionItem) => (
                        <tr key={item.key}>
                          <td className={td}>
                            <StatusBadge status={`priority_${item.priority}`} />
                          </td>
                          <td className={td}>
                            {item.task}
                            <span className="block text-xs text-nw-text-3">{item.caseNumber}</span>
                          </td>
                          <td className={td}>
                            {item.driverName ?? <span className="text-nw-text-3">No driver</span>}
                            {item.truckNumber ? <span className="block text-xs text-nw-text-3">Unit {item.truckNumber}</span> : null}
                          </td>
                          <td className={td}>
                            <OwnerCell name={item.ownerName} />
                          </td>
                          <td className={`${td} whitespace-nowrap`}>
                            <DueText dueOn={item.dueOn} />
                          </td>
                          <td className={td}>
                            <CaseLink type={item.caseType} id={item.caseId} className="inline-flex h-8 items-center rounded-[7px] bg-nw-accent px-3 text-xs font-semibold text-nw-on-accent hover:bg-nw-accent-hover">
                              Open
                            </CaseLink>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <Panel title="Open accident and claim cases" padding="none">
            {overview.isLoading ? <Loading /> : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] border-collapse">
                  <thead className="border-b border-nw-border bg-nw-subtle">
                    <tr>
                      <th className={th}>Case</th>
                      <th className={th}>Type</th>
                      <th className={th}>Current stage</th>
                      <th className={th}>Next action</th>
                      <th className={th}>Owner</th>
                      <th className={th}>Target date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-nw-border">
                    {(o?.openCases ?? []).length === 0 ? (
                      <tr>
                        <td colSpan={6} className="px-3 py-10 text-center text-sm text-nw-text-3">
                          No open accident or claim cases.
                        </td>
                      </tr>
                    ) : (
                      (o?.openCases ?? []).map((c) => (
                        <tr key={`${c.caseType}-${c.caseId}`}>
                          <td className={`${td} whitespace-nowrap`}>
                            <CaseLink type={c.caseType} id={c.caseId}>{c.caseNumber}</CaseLink>
                          </td>
                          <td className={td}>{c.caseType === 'accident' ? 'Accident' : 'Claim'}</td>
                          <td className={td}>{c.stageLabel}</td>
                          <td className={td}>{c.nextAction ?? <span className="text-nw-text-3">None</span>}</td>
                          <td className={td}>
                            <OwnerCell name={c.ownerName} />
                          </td>
                          <td className={`${td} whitespace-nowrap`}>{c.dueOn ? <DueText dueOn={c.dueOn} /> : <span className="text-nw-text-3">None</span>}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
        </div>
        <Panel title="Safety program">
          <ul className="grid gap-3">
            {PROGRAM.map((p) => (
              <li key={p.title} className="flex items-start gap-3">
                <span className="mt-0.5 text-nw-text-3 [&_svg]:size-5" aria-hidden>
                  {p.icon}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-nw-text">{p.title}</span>
                  <span className="block text-xs text-nw-text-3">{p.text}</span>
                </span>
                <Link to={p.to} className="inline-flex items-center gap-1 text-sm font-semibold text-nw-accent-ink">
                  View <ArrowRight className="size-3.5" />
                </Link>
              </li>
            ))}
            <li className="flex items-start gap-3 border-t border-nw-border pt-3">
              <span className="min-w-0 flex-1 text-xs text-nw-text-3">The full compliance workbench: documents, consents and the hiring verification pipeline.</span>
              <Link to="/safety/compliance" search={{ tab: 'drivers' } as never} className="inline-flex items-center gap-1 text-sm font-semibold text-nw-accent-ink">
                Workbench <ArrowRight className="size-3.5" />
              </Link>
            </li>
          </ul>
        </Panel>
      </div>
    </div>
  );
}
