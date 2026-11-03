import { FileSearch, Package, Plus, Truck, Upload } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Alert,
  Button,
  CardSkeleton,
  EmptyState,
  ErrorState,
  KpiSkeleton,
  Skeleton,
  TableSkeleton,
  useToast,
  type AlertTone,
  type ToastTone,
} from '@/design-system';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

const toastExamples: { tone: ToastTone; title: string; description: string }[] = [
  {
    tone: 'success',
    title: 'Load L-100245 dispatched',
    description: 'Marcus Lee · Unit 2785 · picks up 8:00 AM.',
  },
  {
    tone: 'info',
    title: 'Switched to NEWAY Logistics',
    description: 'Data reloaded for the new company.',
  },
  {
    tone: 'warning',
    title: 'Unit 3012 PM service due in 3 days',
    description: 'Schedule before the next dispatch.',
  },
  {
    tone: 'danger',
    title: 'Invoice INV-20418 failed to send',
    description: 'The broker mailbox rejected the message.',
  },
];

const alertTones: { tone: AlertTone; title: string; description: string }[] = [
  {
    tone: 'info',
    title: 'Telematics sync paused',
    description: 'Samsara is rate-limiting requests; locations update every 5 minutes for now.',
  },
  {
    tone: 'success',
    title: 'All 48 trucks passed the annual inspection',
    description: 'Certificates are filed under Safety › Inspections.',
  },
  {
    tone: 'warning',
    title: '3 driver medical cards expire this month',
    description: 'Elena Petrova, Jamal Washington and Marcus Lee need renewals before the 30th.',
  },
  {
    tone: 'danger',
    title: 'Unit 3012 is out of service',
    description: 'Brake fault reported at 6:42 AM. Two loads need reassignment today.',
  },
  {
    tone: 'neutral',
    title: 'Demo data',
    description: 'This company runs on generated data; changes reset on reload.',
  },
];

export function FeedbackSection() {
  const { toast, dismiss } = useToast();
  const [retrying, setRetrying] = useState(false);
  const error = useMemo(() => new Error('Request failed with status 502 (fleet-service)'), []);

  return (
    <GallerySection
      id="feedback"
      index={10}
      title="Feedback"
      note="Success is a toast, never a modal. Loading is a skeleton that matches the final layout. Empty and error states are designed, with an action when there is one."
    >
      <ExampleGroup title="Toast">
        <ExampleGrid columns={1}>
          <Example
            caption="Bottom-right, 5 s, stacked, dismissible · one trigger per tone plus an action toast"
            row
          >
            {toastExamples.map((t) => (
              <Button key={t.tone} variant="secondary" onClick={() => toast(t)}>
                {t.tone.charAt(0).toUpperCase() + t.tone.slice(1)} toast
              </Button>
            ))}
            <Button
              variant="secondary"
              onClick={() =>
                toast({
                  tone: 'success',
                  title: 'Truck 2790 archived',
                  action: {
                    label: 'Undo',
                    onClick: () => toast({ tone: 'info', title: 'Truck 2790 restored' }),
                  },
                })
              }
            >
              With action
            </Button>
            <Button variant="ghost" onClick={() => dismiss()}>
              Dismiss all
            </Button>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Alert">
        <ExampleGrid columns={2}>
          {alertTones.map((a) => (
            <Example key={a.tone} caption={`${a.tone} · title + description`} bare>
              <Alert tone={a.tone} title={a.title} description={a.description} />
            </Example>
          ))}
          <Example caption="Dismissible" bare>
            <Alert
              tone="info"
              dismissible
              title="New: bulk maintenance scheduling"
              description="Select trucks in the table and schedule service for all of them at once."
              onDismiss={() => toast({ tone: 'info', title: 'Alert dismissed' })}
            />
          </Example>
          <Example caption="With actions" bare>
            <Alert
              tone="warning"
              title="Rate confirmation missing on L-100245"
              description="The load cannot be invoiced until the signed rate confirmation is attached."
              actions={
                <>
                  <Button size="sm" variant="secondary" icon={<Upload />}>
                    Upload document
                  </Button>
                  <Button size="sm" variant="link">
                    Request from broker
                  </Button>
                </>
              }
            />
          </Example>
          <Example caption="Danger · dismissible with actions" bare>
            <Alert
              tone="danger"
              dismissible
              title="2 loads have no driver and pick up in under 4 hours"
              description="L-100251 (Joliet, IL) and L-100253 (Gary, IN)."
              actions={
                <Button size="sm" variant="secondary">
                  Open dispatch board
                </Button>
              }
            />
          </Example>
          <Example caption="Description only" bare>
            <Alert
              tone="neutral"
              description="Distances are calculated from the last known GPS position and may lag by a few minutes."
            />
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Empty and error states">
        <ExampleGrid columns={3}>
          <Example caption="EmptyState · md with primary and secondary actions" bare>
            <div className="rounded-lg border border-line bg-surface">
              <EmptyState
                icon={<Truck />}
                title="No trucks yet"
                description="Add your first power unit to start dispatching, tracking and maintaining it."
                action={
                  <Button variant="primary" icon={<Plus />}>
                    Add truck
                  </Button>
                }
                secondaryAction={<Button variant="secondary">Import CSV</Button>}
              />
            </div>
          </Example>
          <Example caption="EmptyState · sm, filter result" bare>
            <div className="rounded-lg border border-line bg-surface">
              <EmptyState
                size="sm"
                icon={<FileSearch />}
                title="No loads match"
                description="Try another status or clear the filters."
                action={
                  <Button size="sm" variant="secondary">
                    Clear filters
                  </Button>
                }
              />
            </div>
          </Example>
          <Example caption="EmptyState · md, default icon, no action" bare>
            <div className="rounded-lg border border-line bg-surface">
              <EmptyState
                title="No recent activity"
                description="Activity from dispatch, safety and accounting shows up here."
              />
            </div>
          </Example>
          <Example caption="ErrorState · md with retry and dev details" bare>
            <div className="rounded-lg border border-line bg-surface">
              <ErrorState
                title="Unable to load fleet data"
                description="The fleet service did not respond. Try again in a moment."
                error={error}
                retrying={retrying}
                onRetry={() => {
                  setRetrying(true);
                  setTimeout(() => setRetrying(false), 800);
                }}
              />
            </div>
          </Example>
          <Example caption="ErrorState · sm, no retry" bare>
            <div className="rounded-lg border border-line bg-surface">
              <ErrorState
                size="sm"
                title="Chart unavailable"
                description="Revenue data could not be loaded."
              />
            </div>
          </Example>
          <Example caption="ErrorState · defaults" bare>
            <div className="rounded-lg border border-line bg-surface">
              <ErrorState onRetry={() => undefined} />
            </div>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Skeletons">
        <ExampleGrid columns={3}>
          <Example caption="Skeleton · text (3 lines), block, circle">
            <div className="flex flex-col gap-4">
              <Skeleton variant="text" lines={3} />
              <Skeleton className="h-8 w-40" />
              <div className="flex items-center gap-3">
                <Skeleton variant="circle" className="size-8" />
                <Skeleton variant="text" lines={2} className="flex-1" />
              </div>
            </div>
          </Example>
          <Example caption="KpiSkeleton" bare>
            <KpiSkeleton />
          </Example>
          <Example caption="CardSkeleton · 4 lines" bare>
            <CardSkeleton />
          </Example>
          <Example caption="TableSkeleton · 5 rows × 5 columns" bare wide>
            <div className="overflow-hidden rounded-lg border border-line bg-surface">
              <TableSkeleton rows={5} columns={5} />
            </div>
          </Example>
          <Example caption="Composed: list card loading" bare>
            <div className="rounded-lg border border-line bg-surface p-(--card-padding)">
              <div className="flex items-center gap-2">
                <Package aria-hidden className="size-4 text-muted" />
                <Skeleton className="h-4 w-32" />
              </div>
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="mt-3 flex items-center gap-3">
                  <Skeleton variant="circle" className="size-6" />
                  <Skeleton className="h-3 flex-1" />
                  <Skeleton className="h-3 w-12" />
                </div>
              ))}
            </div>
          </Example>
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}
