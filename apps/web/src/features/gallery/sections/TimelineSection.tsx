import { subHours, subMinutes } from 'date-fns';
import { CircleCheck, FileText, MapPin, OctagonAlert, Truck, Wrench } from 'lucide-react';
import { ActivityFeed, Timeline, type ActivityItem, type TimelineItem } from '@/design-system';
import { formatDateTime } from '@/lib/format';
import { GALLERY_NOW, galleryActivity, galleryTimeline } from '../galleryData';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

const toneItems: TimelineItem[] = [
  {
    id: 't1',
    at: subMinutes(GALLERY_NOW, 12),
    title: 'Arrived at delivery · Dallas, TX',
    tone: 'success',
    actor: { name: 'Marcus Lee' },
  },
  {
    id: 't2',
    at: subHours(GALLERY_NOW, 2),
    title: 'ETA changed to 2:30 PM',
    description: 'I-35 closure near Waco added 45 minutes.',
    tone: 'warning',
    actor: { name: 'System' },
  },
  {
    id: 't3',
    at: subHours(GALLERY_NOW, 5),
    title: 'Exception raised: running late',
    description: 'Detention at pickup exceeded 2 hours.',
    tone: 'danger',
    actor: { name: 'NEWAY AI' },
  },
  {
    id: 't4',
    at: subHours(GALLERY_NOW, 9),
    title: 'Departed pickup · Chicago, IL',
    tone: 'info',
    actor: { name: 'Marcus Lee' },
  },
  {
    id: 't5',
    at: subHours(GALLERY_NOW, 14),
    title: 'Trailer 5301 swapped in shop',
    tone: 'violet',
  },
  {
    id: 't6',
    at: subHours(GALLERY_NOW, 26),
    title: 'Load booked with Coyote Logistics',
    tone: 'neutral',
    actor: { name: 'Sarah Chen' },
  },
];

const iconItems: TimelineItem[] = [
  {
    id: 'i1',
    at: subMinutes(GALLERY_NOW, 30),
    title: 'Delivered',
    icon: <CircleCheck />,
    tone: 'success',
  },
  {
    id: 'i2',
    at: subHours(GALLERY_NOW, 3),
    title: 'Arrived at Dallas DC',
    description: 'Dock 14, checked in by the guard shack.',
    icon: <MapPin />,
    tone: 'info',
  },
  {
    id: 'i3',
    at: subHours(GALLERY_NOW, 7),
    title: 'Hard brake event · I-44',
    icon: <OctagonAlert />,
    tone: 'danger',
    actor: { name: 'Samsara' },
  },
  {
    id: 'i4',
    at: subHours(GALLERY_NOW, 20),
    title: 'PM service completed',
    description: 'Oil, filters, DPF regen · $642.10',
    icon: <Wrench />,
    tone: 'violet',
  },
  {
    id: 'i5',
    at: subHours(GALLERY_NOW, 30),
    title: 'Rate confirmation uploaded',
    icon: <FileText />,
    tone: 'neutral',
    actor: { name: 'Sarah Chen' },
  },
  {
    id: 'i6',
    at: subHours(GALLERY_NOW, 31),
    title: 'Unit 2785 assigned',
    icon: <Truck />,
    tone: 'info',
  },
];

const demoTimeline: TimelineItem[] = galleryTimeline.map((e) => ({
  id: e.id,
  at: e.at,
  title: e.title,
  description: e.detail,
  tone:
    e.kind === 'delivered' || e.kind === 'closed'
      ? 'success'
      : e.kind === 'exception_raised'
        ? 'danger'
        : e.kind === 'eta_changed'
          ? 'warning'
          : e.kind === 'booked'
            ? 'neutral'
            : 'info',
  actor: { name: e.actorName },
}));

/** Demo summaries read "Sarah Chen assigned … L-100245"; the feed renders the actor and target itself. */
const activityItems: ActivityItem[] = galleryActivity.map((a) => {
  const summary = a.summary.startsWith(a.actorName)
    ? a.summary.slice(a.actorName.length).trim()
    : a.summary;
  const label = a.entity?.label;
  const action =
    label && summary.endsWith(label) ? summary.slice(0, -label.length).trim() : summary;
  return {
    id: a.id,
    actor: { name: a.actorName },
    action,
    target: a.entity ? { label: a.entity.label, href: '#timeline' } : undefined,
    at: a.at,
  };
});

const relativeToDemoNow = (date: Date) => {
  const minutes = Math.round((GALLERY_NOW.getTime() - date.getTime()) / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 1)} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
};

export function TimelineSection() {
  return (
    <GallerySection
      id="timeline"
      index={11}
      title="Timeline & Activity"
      note="Timeline for the history of one entity (a load, a truck): dot or icon per event, absolute time on the right. ActivityFeed for cross-entity streams: avatar + sentence + relative time."
    >
      <ExampleGroup title="Timeline">
        <ExampleGrid columns={3}>
          <Example caption="Dots by tone · with actors and descriptions">
            <Timeline items={toneItems} />
          </Example>
          <Example caption="Icons · 24px circle in the tone colour">
            <Timeline items={iconItems} />
          </Example>
          <Example caption="Dense · demo load L-100245, absolute date + time">
            <Timeline dense items={demoTimeline} formatTime={(d) => formatDateTime(d)} />
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="ActivityFeed">
        <ExampleGrid columns={2}>
          <Example caption="Company activity · entity links, relative time">
            <ActivityFeed
              items={activityItems}
              formatRelative={relativeToDemoNow}
              className="-my-2"
            />
          </Example>
          <Example caption="Explicit targets · and the empty message">
            <ActivityFeed
              className="-my-2"
              formatRelative={relativeToDemoNow}
              items={[
                {
                  id: 'a1',
                  actor: { name: 'Sarah Chen' },
                  action: 'assigned Unit 2785 to',
                  target: { label: 'Load L-100245', href: '#timeline' },
                  at: subMinutes(GALLERY_NOW, 4),
                },
                {
                  id: 'a2',
                  actor: { name: 'Marcus Lee' },
                  action: 'uploaded the POD for',
                  target: { label: 'L-100238' },
                  at: subHours(GALLERY_NOW, 1),
                },
                {
                  id: 'a3',
                  actor: { name: 'NEWAY AI' },
                  action: 'flagged a 9% MPG drop on',
                  target: { label: 'Unit 3012', href: '#timeline' },
                  at: subHours(GALLERY_NOW, 3),
                },
                {
                  id: 'a4',
                  actor: { name: 'Elena Petrova' },
                  action: 'logged in from the driver app',
                  at: subHours(GALLERY_NOW, 6),
                },
              ]}
            />
            <div className="mt-3 border-t border-line-soft">
              <ActivityFeed items={[]} emptyMessage="No activity in the last 7 days" />
            </div>
          </Example>
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}
