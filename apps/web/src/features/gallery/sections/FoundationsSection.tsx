import { STATUS, STATUS_CODES, StatusBadge, cn, type StatusTone } from '@/design-system';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

interface Swatch {
  name: string;
  className: string;
}

const colorGroups: { title: string; swatches: Swatch[] }[] = [
  {
    title: 'Surfaces',
    swatches: [
      { name: 'app', className: 'bg-app' },
      { name: 'surface', className: 'bg-surface' },
      { name: 'surface-muted', className: 'bg-surface-muted' },
      { name: 'surface-hover', className: 'bg-surface-hover' },
      { name: 'surface-active', className: 'bg-surface-active' },
      { name: 'sidebar', className: 'bg-sidebar' },
      { name: 'sidebar-hover', className: 'bg-sidebar-hover' },
      { name: 'overlay', className: 'bg-overlay' },
    ],
  },
  {
    title: 'Lines',
    swatches: [
      { name: 'line', className: 'bg-line' },
      { name: 'line-strong', className: 'bg-line-strong' },
      { name: 'line-soft', className: 'bg-line-soft' },
    ],
  },
  {
    title: 'Text',
    swatches: [
      { name: 'ink', className: 'bg-ink' },
      { name: 'secondary', className: 'bg-secondary' },
      { name: 'muted', className: 'bg-muted' },
      { name: 'faint', className: 'bg-faint' },
      { name: 'inverse', className: 'bg-inverse' },
    ],
  },
  {
    title: 'Action',
    swatches: [
      { name: 'primary', className: 'bg-primary' },
      { name: 'primary-hover', className: 'bg-primary-hover' },
      { name: 'primary-active', className: 'bg-primary-active' },
      { name: 'primary-soft', className: 'bg-primary-soft' },
      { name: 'primary-soft-hover', className: 'bg-primary-soft-hover' },
      { name: 'primary-border', className: 'bg-primary-border' },
      { name: 'primary-text', className: 'bg-primary-text' },
      { name: 'focus', className: 'bg-focus' },
    ],
  },
  {
    title: 'Success',
    swatches: [
      { name: 'success', className: 'bg-success' },
      { name: 'success-soft', className: 'bg-success-soft' },
      { name: 'success-border', className: 'bg-success-border' },
      { name: 'success-text', className: 'bg-success-text' },
    ],
  },
  {
    title: 'Warning',
    swatches: [
      { name: 'warning', className: 'bg-warning' },
      { name: 'warning-soft', className: 'bg-warning-soft' },
      { name: 'warning-border', className: 'bg-warning-border' },
      { name: 'warning-text', className: 'bg-warning-text' },
    ],
  },
  {
    title: 'Danger',
    swatches: [
      { name: 'danger', className: 'bg-danger' },
      { name: 'danger-hover', className: 'bg-danger-hover' },
      { name: 'danger-soft', className: 'bg-danger-soft' },
      { name: 'danger-border', className: 'bg-danger-border' },
      { name: 'danger-text', className: 'bg-danger-text' },
    ],
  },
  {
    title: 'Info',
    swatches: [
      { name: 'info', className: 'bg-info' },
      { name: 'info-soft', className: 'bg-info-soft' },
      { name: 'info-border', className: 'bg-info-border' },
      { name: 'info-text', className: 'bg-info-text' },
    ],
  },
  {
    title: 'Neutral',
    swatches: [
      { name: 'neutral', className: 'bg-neutral' },
      { name: 'neutral-soft', className: 'bg-neutral-soft' },
      { name: 'neutral-border', className: 'bg-neutral-border' },
      { name: 'neutral-text', className: 'bg-neutral-text' },
    ],
  },
  {
    title: 'Accent (sparingly)',
    swatches: [
      { name: 'violet', className: 'bg-violet' },
      { name: 'violet-soft', className: 'bg-violet-soft' },
      { name: 'violet-border', className: 'bg-violet-border' },
      { name: 'violet-text', className: 'bg-violet-text' },
    ],
  },
  {
    title: 'Chart series (fixed order)',
    swatches: [
      { name: 'chart-series-1', className: 'bg-(--chart-series-1)' },
      { name: 'chart-series-2', className: 'bg-(--chart-series-2)' },
      { name: 'chart-series-3', className: 'bg-(--chart-series-3)' },
      { name: 'chart-series-4', className: 'bg-(--chart-series-4)' },
      { name: 'chart-series-5', className: 'bg-(--chart-series-5)' },
      { name: 'chart-series-6', className: 'bg-(--chart-series-6)' },
      { name: 'chart-series-7', className: 'bg-(--chart-series-7)' },
      { name: 'chart-series-8', className: 'bg-(--chart-series-8)' },
    ],
  },
  {
    title: 'Chart sequential',
    swatches: [
      { name: 'chart-seq-1', className: 'bg-(--chart-seq-1)' },
      { name: 'chart-seq-2', className: 'bg-(--chart-seq-2)' },
      { name: 'chart-seq-3', className: 'bg-(--chart-seq-3)' },
      { name: 'chart-seq-4', className: 'bg-(--chart-seq-4)' },
      { name: 'chart-seq-5', className: 'bg-(--chart-seq-5)' },
      { name: 'chart-seq-6', className: 'bg-(--chart-seq-6)' },
      { name: 'chart-seq-7', className: 'bg-(--chart-seq-7)' },
    ],
  },
  {
    title: 'Chart status',
    swatches: [
      { name: 'chart-good', className: 'bg-(--chart-good)' },
      { name: 'chart-warning', className: 'bg-(--chart-warning)' },
      { name: 'chart-serious', className: 'bg-(--chart-serious)' },
      { name: 'chart-critical', className: 'bg-(--chart-critical)' },
      { name: 'chart-grid', className: 'bg-(--chart-grid)' },
      { name: 'chart-axis', className: 'bg-(--chart-axis)' },
    ],
  },
];

const typeScale: { role: string; className: string; spec: string }[] = [
  {
    role: 'Page title',
    className: 'text-2xl font-semibold tracking-tight text-ink',
    spec: '20 / 600',
  },
  { role: 'Display (3xl)', className: 'text-3xl font-semibold text-ink', spec: '24 / 600' },
  { role: 'Section title (xl)', className: 'text-xl font-semibold text-ink', spec: '18 / 600' },
  { role: 'Drawer title (md)', className: 'text-md font-semibold text-ink', spec: '15 / 600' },
  { role: 'Card title', className: 'text-base font-semibold text-ink', spec: '14 / 600' },
  { role: 'Body', className: 'text-base text-ink', spec: '14 / 400' },
  { role: 'Secondary', className: 'text-sm text-secondary', spec: '13 / 400' },
  { role: 'Page description', className: 'text-sm text-muted', spec: '13 / 400' },
  { role: 'Field label', className: 'text-sm font-medium text-ink', spec: '13 / 500' },
  {
    role: 'Table header',
    className: 'text-xs font-medium tracking-eyebrow text-muted uppercase',
    spec: '12 / 500',
  },
  { role: 'Metadata', className: 'text-xs text-muted', spec: '12 / 400' },
  { role: 'Eyebrow', className: 'eyebrow', spec: '11 / 600' },
  { role: 'Badge (2xs)', className: 'text-2xs font-medium text-ink', spec: '11 / 500' },
  { role: 'Numbers', className: 'tabular text-base text-ink', spec: 'tabular figures' },
];

const spacing = [
  { name: 'gap-1', px: 4, className: 'w-1' },
  { name: 'gap-2', px: 8, className: 'w-2' },
  { name: 'gap-3', px: 12, className: 'w-3' },
  { name: 'gap-4', px: 16, className: 'w-4' },
  { name: 'gap-6', px: 24, className: 'w-6' },
  { name: 'gap-8', px: 32, className: 'w-8' },
];

const radii = [
  { name: 'rounded-xs', className: 'rounded-xs' },
  { name: 'rounded-sm', className: 'rounded-sm' },
  { name: 'rounded-md', className: 'rounded-md' },
  { name: 'rounded-lg', className: 'rounded-lg' },
  { name: 'rounded-xl', className: 'rounded-xl' },
  { name: 'rounded-full', className: 'rounded-full' },
];

const shadows = [
  { name: 'shadow-xs', className: 'shadow-xs' },
  { name: 'shadow-sm', className: 'shadow-sm' },
  { name: 'shadow-md', className: 'shadow-md' },
  { name: 'shadow-lg', className: 'shadow-lg' },
  { name: 'shadow-focus', className: 'shadow-focus' },
];

const toneOrder: StatusTone[] = ['success', 'info', 'warning', 'danger', 'neutral', 'violet'];
const toneLabel: Record<StatusTone, string> = {
  success: 'Success — healthy / done',
  info: 'Info — in motion',
  warning: 'Warning — attention',
  danger: 'Danger — critical',
  neutral: 'Neutral — inactive / final',
  violet: 'Accent — categorisation',
};

export function FoundationsSection() {
  return (
    <GallerySection
      id="foundations"
      index={1}
      title="Foundations"
      note="Tokens from tokens.css: every color, type size, radius and shadow used in the product. Raw hex or px values in components are a review failure."
    >
      <ExampleGroup title="Color">
        <ExampleGrid columns={3}>
          {colorGroups.map((group) => (
            <Example key={group.title} caption={group.title}>
              <ul className="grid grid-cols-4 gap-2">
                {group.swatches.map((swatch) => (
                  <li key={swatch.name} className="flex min-w-0 flex-col gap-1">
                    <span
                      aria-hidden
                      className={cn('h-8 w-full rounded-md border border-line', swatch.className)}
                    />
                    <span className="font-mono text-2xs leading-tight break-all text-muted">
                      {swatch.name}
                    </span>
                  </li>
                ))}
              </ul>
            </Example>
          ))}
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Typography">
        <Example caption="Type scale · Inter, weights 400 / 500 / 600 only">
          <ul className="divide-y divide-line-soft">
            {typeScale.map((row) => (
              <li
                key={row.role}
                className="grid grid-cols-1 items-baseline gap-x-6 gap-y-1 py-2.5 md:grid-cols-[9rem_minmax(0,1fr)_18rem]"
              >
                <span className="text-xs text-muted">{row.role}</span>
                <span className={cn('truncate', row.className)}>
                  Unit 2785 delivered load L-100245 to Dallas, TX
                </span>
                <span className="font-mono text-2xs leading-tight text-muted">
                  {row.className} · {row.spec}
                </span>
              </li>
            ))}
          </ul>
        </Example>
      </ExampleGroup>

      <ExampleGroup title="Spacing, radius and shadow">
        <ExampleGrid columns={3}>
          <Example caption="Spacing scale (4px base)">
            <ul className="flex flex-col gap-2">
              {spacing.map((step) => (
                <li key={step.name} className="flex items-center gap-3 text-xs text-muted">
                  <span className="w-12 font-mono text-2xs">{step.name}</span>
                  <span aria-hidden className={cn('h-4 rounded-xs bg-primary', step.className)} />
                  <span className="tabular">{step.px}px</span>
                </li>
              ))}
            </ul>
          </Example>
          <Example caption="Radius · xs 3 · sm 4 · md 6 · lg 8 · xl 10 · full">
            <ul className="flex flex-wrap items-end gap-4">
              {radii.map((radius) => (
                <li key={radius.name} className="flex flex-col items-center gap-1.5">
                  <span
                    aria-hidden
                    className={cn(
                      'size-10 border border-line-strong bg-surface-muted',
                      radius.className,
                    )}
                  />
                  <span className="font-mono text-2xs text-muted">{radius.name}</span>
                </li>
              ))}
            </ul>
          </Example>
          <Example caption="Shadow · xs cards · md popovers · lg drawers and modals">
            <ul className="flex flex-wrap items-end gap-5 py-2">
              {shadows.map((shadow) => (
                <li key={shadow.name} className="flex flex-col items-center gap-2">
                  <span
                    aria-hidden
                    className={cn(
                      'size-10 rounded-md border border-line bg-surface',
                      shadow.className,
                    )}
                  />
                  <span className="font-mono text-2xs text-muted">{shadow.name}</span>
                </li>
              ))}
            </ul>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Status system">
        <p className="-mt-1 text-sm text-muted">
          Every status code in <code className="font-mono text-xs">design-system/status.ts</code>,
          grouped by tone. Warning and danger carry an icon so color is never the only signal.
        </p>
        <ExampleGrid columns={2}>
          {toneOrder.map((tone) => (
            <Example key={tone} caption={toneLabel[tone]} row>
              {STATUS_CODES.filter((code) => STATUS[code].tone === tone).map((code) => (
                <StatusBadge key={code} status={code} title={code} />
              ))}
            </Example>
          ))}
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}
