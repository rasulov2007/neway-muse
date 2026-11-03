import { Flame, Snowflake } from 'lucide-react';
import { Avatar, Badge, type BadgeTone } from '@/design-system';
import { galleryDrivers } from '../galleryData';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

const tones: { tone: BadgeTone; label: string }[] = [
  { tone: 'neutral', label: 'Draft' },
  { tone: 'info', label: 'In transit' },
  { tone: 'success', label: 'Delivered' },
  { tone: 'warning', label: 'Due soon' },
  { tone: 'danger', label: 'Overdue' },
  { tone: 'violet', label: 'In shop' },
];

export function BadgesSection() {
  const [a, b, c] = galleryDrivers;
  return (
    <GallerySection
      id="badges"
      index={5}
      title="Badges & Avatars"
      note="Badges are 20px tall (18px sm) and always carry text; the tone never carries meaning alone. Avatars fall back to initials on a neutral background."
    >
      <ExampleGroup title="Badge">
        <ExampleGrid columns={2}>
          <Example caption="Soft · md" row>
            {tones.map((t) => (
              <Badge key={t.tone} tone={t.tone}>
                {t.label}
              </Badge>
            ))}
          </Example>
          <Example caption="Outline · md" row>
            {tones.map((t) => (
              <Badge key={t.tone} tone={t.tone} variant="outline">
                {t.label}
              </Badge>
            ))}
          </Example>
          <Example caption="Soft · sm" row>
            {tones.map((t) => (
              <Badge key={t.tone} tone={t.tone} size="sm">
                {t.label}
              </Badge>
            ))}
          </Example>
          <Example caption="Outline · sm" row>
            {tones.map((t) => (
              <Badge key={t.tone} tone={t.tone} variant="outline" size="sm">
                {t.label}
              </Badge>
            ))}
          </Example>
          <Example caption="With dot" row>
            {tones.map((t) => (
              <Badge key={t.tone} tone={t.tone} dot>
                {t.label}
              </Badge>
            ))}
          </Example>
          <Example caption="With icon · counts (tabular)" row>
            <Badge tone="danger" icon={<Flame aria-hidden />}>
              Hazmat
            </Badge>
            <Badge tone="info" icon={<Snowflake aria-hidden />}>
              Reefer −10 °F
            </Badge>
            <Badge tone="neutral" className="tabular">
              12
            </Badge>
            <Badge tone="neutral" size="sm" className="tabular">
              377
            </Badge>
            <Badge tone="warning" variant="outline" dot size="sm">
              3 expiring
            </Badge>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Avatar">
        <ExampleGrid columns={3}>
          <Example caption="Sizes · sm 24 / md 32 / lg 40" row>
            <Avatar name={a?.name ?? 'Driver'} size="sm" />
            <Avatar name={a?.name ?? 'Driver'} size="md" />
            <Avatar name={a?.name ?? 'Driver'} size="lg" />
          </Example>
          <Example caption="Initials fallback · broken image falls back too" row>
            <Avatar name={b?.name ?? 'Driver'} />
            <Avatar name={c?.name ?? 'Driver'} src="/avatars/missing.png" />
            <Avatar name="Cher" />
            <Avatar name="" />
          </Example>
          <Example caption="In a row with names">
            <ul className="flex flex-col gap-2">
              {galleryDrivers.slice(0, 3).map((d) => (
                <li key={d.id} className="flex items-center gap-2.5">
                  <Avatar name={d.name} size="sm" />
                  <span className="text-sm text-ink">{d.name}</span>
                  <span className="text-xs text-muted">{d.driverNumber}</span>
                </li>
              ))}
            </ul>
          </Example>
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}
