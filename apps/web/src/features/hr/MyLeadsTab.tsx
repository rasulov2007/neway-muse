import { Link2Off, MessageSquareText, PhoneCall } from 'lucide-react';
import { useState } from 'react';
import {
  LEAD_SOURCE_LABELS,
  LEAD_STATUS_LABELS,
  isRecruiterPosition,
  type LeadStatus,
  type MyLeadRow,
} from '@neway/shared';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  Drawer,
  EmptyState,
  FormField,
  Select,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { formatDateTime, formatPhone } from '@/lib/format';
import type { HrSearch } from './hr-search';
import { AddNoteDialog, LeadNotesHistory, NoteLine, type NoteTarget } from './LeadNotes';
import { useMyLeads } from './useHiring';

/** The same status badges as the Leads list: New is red until somebody contacts the lead. */
const TONE: Record<LeadStatus, 'success' | 'neutral' | 'danger'> = {
  new: 'danger',
  no_answer: 'danger',
  contacted: 'neutral',
  prequalified: 'success',
  converted: 'success',
  dead: 'neutral',
};

/** What the recruiter does next with a lead in this status. */
const NEXT_STEP: Record<LeadStatus, string> = {
  new: 'Call them, then mark contacted',
  no_answer: 'Call again',
  contacted: 'Record the prequalification',
  prequalified: 'Convert to candidate',
  converted: 'In the pipeline',
  dead: 'Nothing — disqualified',
};

const sourceLabel = (source: string) => LEAD_SOURCE_LABELS[source] ?? source.replace(/_/g, ' ');

function StatusCell({ status }: { status: LeadStatus }) {
  return (
    <Badge tone={TONE[status]} dot size="sm">
      {status === 'new' ? 'New · needs contact' : LEAD_STATUS_LABELS[status]}
    </Badge>
  );
}

/**
 * My leads (owner, 2026-10-07): the leads assigned to the signed-in recruiter — online
 * applications arrive here by turn — with the newest note on each and a quick "Add note".
 * A recruiting manager can switch to any recruiter's list.
 */
export function MyLeadsTab({
  search,
  update,
  onOpenTab,
}: {
  search: HrSearch;
  update: (patch: Record<string, unknown>) => void;
  onOpenTab: (tab: string, extra?: Record<string, unknown>) => void;
}) {
  const account = useAccount();
  const canManage = account?.permissions.includes('recruiting.manage') ?? false;
  const employees = useEmployeeDirectory();
  const mine = useMyLeads(canManage ? search.recruiter : undefined);
  const [noteFor, setNoteFor] = useState<NoteTarget | null>(null);
  const data = mine.data;
  const selected = data?.leads.find((l) => l.id === search.lead) ?? null;

  const recruiterOptions = (employees.data ?? [])
    .filter((e) => e.id === search.recruiter || (e.status !== 'terminated' && isRecruiterPosition(e.position)))
    .map((e) => ({ value: e.id, label: `${e.firstName} ${e.lastName}` }));

  const picker = canManage ? (
    <FormField label="Recruiter" className="w-full max-w-xs">
      <Select
        aria-label="Recruiter"
        value={search.recruiter ?? ''}
        onValueChange={(v) => update({ recruiter: v || undefined, lead: undefined })}
        options={[{ value: '', label: 'My leads' }, ...recruiterOptions]}
      />
    </FormField>
  ) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="my-leads-tab">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <h2 className="text-lg font-bold text-ink">
            {mine.isPending ? 'Loading…' : data?.recruiter ? `${data.recruiter.name}’s leads` : 'My leads'}
          </h2>
          <p className="text-sm text-muted">
            Online applications are shared out to recruiters in turn. Work first: new leads on top.
          </p>
        </div>
        {picker}
      </div>

      {mine.error ? (
        <Alert
          tone="danger"
          title="Your leads could not be loaded"
          description={mine.error instanceof Error ? mine.error.message : 'Unknown error'}
        />
      ) : mine.isPending ? (
        <Card>
          <p className="text-sm text-muted">Loading…</p>
        </Card>
      ) : !data?.recruiter ? (
        <Card>
          <EmptyState
            icon={<Link2Off />}
            title="Your account isn't linked to a recruiter"
            description={
              canManage
                ? 'Ask an administrator to link it in Administration › Users. Meanwhile, pick a recruiter above to see their leads.'
                : "Your account isn't linked to a recruiter. Ask an administrator to link it in Administration › Users."
            }
          />
        </Card>
      ) : (
        <>
          {!data.recruiter.isRecruiter ? (
            <Alert
              tone="info"
              title={`${data.recruiter.name} is not a recruiter`}
              description="Their position is not Recruiter, so online applications are not shared out to them. Leads assigned by hand still show here."
            />
          ) : null}
          {data.leads.length === 0 ? (
            <Card>
              <EmptyState
                icon={<PhoneCall />}
                title="No leads assigned yet"
                description="New online applications are shared out automatically; yours will appear here."
              />
            </Card>
          ) : (
            <Card padding="none">
              <div className="overflow-x-auto">
                <table className="w-full min-w-[900px] text-sm" data-testid="my-leads-table">
                  <thead className="border-b border-line bg-surface-muted text-left text-xs font-semibold text-muted">
                    <tr>
                      <th className="px-4 py-2">Driver</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Source</th>
                      <th className="px-3 py-2">Added</th>
                      <th className="px-3 py-2">Last note</th>
                      <th className="px-3 py-2">Next step</th>
                      <th className="px-3 py-2">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-line-soft">
                    {data.leads.map((l) => (
                      <LeadRow
                        key={l.id}
                        lead={l}
                        canWrite={canManage}
                        onOpen={() => update({ lead: l.id })}
                        onNote={() => setNoteFor({ leadId: l.id, name: l.name })}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </>
      )}

      <Drawer
        open={Boolean(search.lead) && selected !== null}
        onOpenChange={(o) => {
          if (!o) update({ lead: undefined });
        }}
        title={selected?.name ?? 'Lead'}
        description={selected ? `${selected.leadNumber} · ${formatPhone(selected.phone)}` : undefined}
        headerExtra={selected ? <StatusCell status={selected.status} /> : null}
        size="md"
        footer={
          selected ? (
            <Button variant="outline" onClick={() => onOpenTab('leads', { lead: selected.id })}>
              Open the full lead
            </Button>
          ) : undefined
        }
      >
        {selected ? (
          <div className="flex flex-col gap-5">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <Fact label="Source">{sourceLabel(selected.source)}</Fact>
              <Fact label="Added">{formatDateTime(selected.createdAt)}</Fact>
              <Fact label="Contacted">
                {selected.contactedAt ? formatDateTime(selected.contactedAt) : <span className="text-faint">Not yet</span>}
              </Fact>
              <Fact label="Next step">{NEXT_STEP[selected.status]}</Fact>
            </dl>
            <LeadNotesHistory
              leadId={selected.id}
              canWrite={canManage}
              onAddNote={() => setNoteFor({ leadId: selected.id, name: selected.name })}
            />
          </div>
        ) : null}
      </Drawer>

      {noteFor ? <AddNoteDialog target={noteFor} onClose={() => setNoteFor(null)} /> : null}
    </div>
  );
}

function LeadRow({
  lead,
  canWrite,
  onOpen,
  onNote,
}: {
  lead: MyLeadRow;
  canWrite: boolean;
  onOpen: () => void;
  onNote: () => void;
}) {
  return (
    <tr className="cursor-pointer hover:bg-surface-muted" onClick={onOpen}>
      <td className="px-4 py-2">
        <span className="flex items-center gap-2">
          <Avatar name={lead.name} size="sm" />
          <span className="min-w-0">
            <span className="block truncate font-semibold text-ink">{lead.name}</span>
            <span className="block text-xs text-muted">
              {formatPhone(lead.phone)} · {lead.leadNumber}
            </span>
          </span>
        </span>
      </td>
      <td className="px-3 py-2">
        <StatusCell status={lead.status} />
      </td>
      <td className="px-3 py-2 text-secondary">{sourceLabel(lead.source)}</td>
      <td className="px-3 py-2 whitespace-nowrap text-secondary">{formatDateTime(lead.createdAt)}</td>
      <td className="max-w-[280px] px-3 py-2">
        {lead.lastNote ? <NoteLine note={lead.lastNote} compact /> : <span className="text-faint">No notes yet</span>}
      </td>
      <td className="px-3 py-2 text-secondary">{NEXT_STEP[lead.status]}</td>
      <td className="px-3 py-2 text-right">
        {canWrite ? (
          <Button
            variant="outline"
            size="sm"
            icon={<MessageSquareText />}
            onClick={(e) => {
              e.stopPropagation();
              onNote();
            }}
          >
            Add note
          </Button>
        ) : null}
      </td>
    </tr>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}
