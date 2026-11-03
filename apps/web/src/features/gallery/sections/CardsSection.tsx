import { Activity, CircleDollarSign, Ellipsis, OctagonAlert, Package, Truck } from 'lucide-react';
import {
  Button,
  Card,
  IconButton,
  KpiCard,
  SectionLabel,
  StatusBadge,
  useToast,
} from '@/design-system';
import { formatMiles, formatMoney } from '@/lib/format';
import { heroTruck, revenueSparkline } from '../galleryData';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

export function CardsSection() {
  const { toast } = useToast();
  return (
    <GallerySection
      id="cards"
      index={6}
      title="Cards & KPI cards"
      note="Cards only when grouping is needed: border + shadow-xs, no hover lift unless interactive. KPI cards are compact stat tiles with a signed delta."
    >
      <ExampleGroup title="Card">
        <ExampleGrid columns={3}>
          <Example caption="Title + description" bare>
            <Card
              title="Unit 2785"
              description={`${heroTruck.year} ${heroTruck.make} ${heroTruck.model}`}
            >
              <dl className="grid grid-cols-2 gap-y-2 text-sm">
                <dt className="text-muted">Odometer</dt>
                <dd className="tabular text-right text-ink">{formatMiles(heroTruck.odometer)}</dd>
                <dt className="text-muted">Driver</dt>
                <dd className="text-right text-ink">{heroTruck.currentDriverName ?? '—'}</dd>
                <dt className="text-muted">Status</dt>
                <dd className="text-right">
                  <StatusBadge status={heroTruck.status} />
                </dd>
              </dl>
            </Card>
          </Example>
          <Example caption="Actions + footer" bare>
            <Card
              title="Upcoming maintenance"
              description="Next 14 days"
              actions={
                <>
                  <Button size="sm" variant="secondary">
                    Schedule
                  </Button>
                  <IconButton size="sm" label="More">
                    <Ellipsis />
                  </IconButton>
                </>
              }
              footer={
                <Button variant="link" size="sm">
                  View all 12
                </Button>
              }
            >
              <ul className="flex flex-col gap-2 text-sm">
                <li className="flex items-center justify-between gap-3">
                  <span className="text-ink">Unit 2785 · PM service</span>
                  <StatusBadge status="due_soon" size="sm" />
                </li>
                <li className="flex items-center justify-between gap-3">
                  <span className="text-ink">Unit 3012 · DOT inspection</span>
                  <StatusBadge status="overdue" size="sm" />
                </li>
                <li className="flex items-center justify-between gap-3">
                  <span className="text-ink">Unit 2790 · Brake inspection</span>
                  <StatusBadge status="scheduled" size="sm" />
                </li>
              </ul>
            </Card>
          </Example>
          <Example caption="Interactive · hover affordance" bare>
            <Card
              interactive
              title="Load L-100245"
              description="Chicago, IL → Dallas, TX"
              role="button"
              tabIndex={0}
              onClick={() => toast({ tone: 'info', title: 'Opens load L-100245' })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  toast({ tone: 'info', title: 'Opens load L-100245' });
                }
              }}
            >
              <div className="flex items-center justify-between text-sm">
                <StatusBadge status="in_transit" />
                <span className="tabular text-ink">{formatMoney(3250)}</span>
              </div>
            </Card>
          </Example>
          <Example caption="Padding sm · with SectionLabel" bare>
            <Card padding="sm">
              <SectionLabel className="mb-2">Dispatcher</SectionLabel>
              <p className="text-sm text-ink">Sarah Chen</p>
              <p className="text-xs text-muted">Operations Manager</p>
            </Card>
          </Example>
          <Example caption="Padding none · flush content" bare>
            <Card padding="none" title="Recent loads">
              <ul className="divide-y divide-line-soft text-sm">
                {['L-100245', 'L-100244', 'L-100243'].map((n) => (
                  <li key={n} className="flex items-center justify-between px-4 py-2.5">
                    <span className="font-medium text-primary-text">{n}</span>
                    <span className="text-muted">Delivered</span>
                  </li>
                ))}
              </ul>
            </Card>
          </Example>
          <Example caption="Body only" bare>
            <Card>
              <p className="text-sm text-secondary">
                A plain card with the default 16px padding and no header or footer.
              </p>
            </Card>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="KpiCard">
        <ExampleGrid columns={4}>
          <Example caption="Normal · no delta" bare>
            <KpiCard label="Total trucks" value="48" icon={<Truck />} hint="2 in shop" />
          </Example>
          <Example caption="Positive delta" bare>
            <KpiCard
              label="Revenue (MTD)"
              value={formatMoney(842_300, { compact: true })}
              delta={{ value: 6.4, label: 'vs last month' }}
              icon={<CircleDollarSign />}
            />
          </Example>
          <Example caption="Negative delta" bare>
            <KpiCard
              label="Active loads"
              value="37"
              delta={{ value: -4.7, label: 'vs last week' }}
              icon={<Package />}
            />
          </Example>
          <Example caption="Flat delta" bare>
            <KpiCard
              label="Active trucks"
              value="41"
              delta={{ value: 0, label: 'vs last week' }}
              icon={<Activity />}
            />
          </Example>
          <Example caption="Increase is bad (positiveIsGood: false)" bare>
            <KpiCard
              label="Critical alerts"
              value="3"
              delta={{ value: 50, label: 'vs yesterday', positiveIsGood: false }}
              hint={<span className="font-medium text-danger-text">Needs action</span>}
              icon={<OctagonAlert className="text-danger" />}
            />
          </Example>
          <Example caption="With sparkline" bare>
            <KpiCard
              label="Weekly revenue"
              value={formatMoney(revenueSparkline.at(-1) ?? 0, { compact: true })}
              delta={{ value: 3.1, label: 'vs last week' }}
              sparkline={revenueSparkline}
            />
          </Example>
          <Example caption="Loading" bare>
            <KpiCard label="Net profit" value="—" loading />
          </Example>
          <Example caption="Clickable" bare>
            <KpiCard
              label="Overdue invoices"
              value={formatMoney(28_450)}
              delta={{ value: -12.5, label: 'vs last month', positiveIsGood: false }}
              onClick={() => toast({ tone: 'info', title: 'Opens Accounts receivable' })}
            />
          </Example>
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}
