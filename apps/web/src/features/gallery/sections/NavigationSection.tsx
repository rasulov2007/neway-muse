import { Download, Plus, Wrench } from 'lucide-react';
import { useState } from 'react';
import {
  BackButton,
  Breadcrumb,
  Button,
  PageHeader,
  StatusBadge,
  Tabs,
  TabsContent,
  type TabItem,
} from '@/design-system';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

const loadTabs: TabItem[] = [
  { value: 'all', label: 'All', count: 377 },
  { value: 'active', label: 'Active', count: 42 },
  { value: 'at_risk', label: 'At risk', count: 3 },
  { value: 'delivered', label: 'Delivered', count: 318 },
  { value: 'cancelled', label: 'Cancelled', count: 14, disabled: true },
];

const detailTabs: TabItem[] = [
  { value: 'overview', label: 'Overview' },
  { value: 'stops', label: 'Stops', count: 2 },
  { value: 'financials', label: 'Financials' },
  { value: 'documents', label: 'Documents', count: 4 },
  { value: 'activity', label: 'Activity' },
];

const periodTabs: TabItem[] = [
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'ytd', label: 'YTD' },
];

export function NavigationSection() {
  const [period, setPeriod] = useState('30d');
  return (
    <GallerySection
      id="navigation"
      index={8}
      title="Navigation"
      note="Underline tabs for page sections, segmented tabs for filters. Breadcrumb ends with the current page (not a link). PageHeader holds at most one primary action."
    >
      <ExampleGroup title="Tabs">
        <ExampleGrid columns={2}>
          <Example caption="Underline · md with counts, one disabled">
            <Tabs items={loadTabs} defaultValue="active" aria-label="Load lists">
              <TabsContent value="all" className="pt-3 text-sm text-secondary">
                All 377 loads.
              </TabsContent>
              <TabsContent value="active" className="pt-3 text-sm text-secondary">
                42 active loads, 3 of them at risk.
              </TabsContent>
              <TabsContent value="at_risk" className="pt-3 text-sm text-secondary">
                L-100245 is running 2 h behind its delivery appointment.
              </TabsContent>
              <TabsContent value="delivered" className="pt-3 text-sm text-secondary">
                318 delivered this quarter.
              </TabsContent>
            </Tabs>
          </Example>
          <Example caption="Underline · sm">
            <Tabs items={detailTabs} defaultValue="overview" size="sm" aria-label="Load detail" />
          </Example>
          <Example caption="Segmented · md, controlled" row>
            <Tabs
              variant="segmented"
              items={periodTabs}
              value={period}
              onValueChange={setPeriod}
              aria-label="Period"
            />
            <span className="text-sm text-muted">
              Showing the last {period === 'ytd' ? 'year to date' : period}
            </span>
          </Example>
          <Example caption="Segmented · sm" row>
            <Tabs
              variant="segmented"
              size="sm"
              items={[
                { value: 'list', label: 'List' },
                { value: 'map', label: 'Map' },
                { value: 'board', label: 'Board', disabled: true },
              ]}
              defaultValue="list"
              aria-label="View"
            />
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Breadcrumb">
        <ExampleGrid columns={3}>
          <Example caption="Two levels">
            <Breadcrumb items={[{ label: 'Fleet', href: '#navigation' }, { label: 'Trucks' }]} />
          </Example>
          <Example caption="Three levels · entity page">
            <Breadcrumb
              items={[
                { label: 'Fleet', href: '#navigation' },
                { label: 'Trucks', href: '#navigation' },
                { label: 'Unit 2785' },
              ]}
            />
          </Example>
          <Example caption="Group label without a link">
            <Breadcrumb
              items={[
                { label: 'Accounting' },
                { label: 'Invoices', href: '#navigation' },
                { label: 'INV-20418' },
              ]}
            />
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="PageHeader">
        <ExampleGrid columns={1}>
          <Example caption="Breadcrumb, title, meta badges, description, actions and a tab strip (example is aria-hidden so this page keeps a single h1)">
            <PageHeaderExample />
          </Example>
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}

/**
 * PageHeader renders an h1. The gallery page already has one, so this purely visual example is
 * hidden from assistive technology; the sr-only line describes it instead.
 */
function PageHeaderExample() {
  return (
    <div>
      <p className="sr-only">
        Example page header for Unit 2785 with breadcrumb, status badges, three actions and tabs.
      </p>
      <div aria-hidden>
        <PageHeader
          back={<BackButton fallback="#navigation" />}
          title="Unit 2785"
          description="2022 Freightliner Cascadia · VIN 1FUJGLDR5NLAB2785 · Chicago terminal"
          meta={
            <>
              <StatusBadge status="driving" />
              <StatusBadge status="due_soon" />
            </>
          }
          actions={
            <>
              <Button variant="secondary" icon={<Download />}>
                Export
              </Button>
              <Button variant="secondary" icon={<Wrench />}>
                Schedule maintenance
              </Button>
              <Button variant="primary" icon={<Plus />}>
                Assign load
              </Button>
            </>
          }
          tabs={
            <Tabs
              items={[
                { value: 'overview', label: 'Overview' },
                { value: 'maintenance', label: 'Maintenance', count: 2 },
                { value: 'loads', label: 'Loads', count: 118 },
                { value: 'fuel', label: 'Fuel' },
                { value: 'documents', label: 'Documents' },
              ]}
              defaultValue="overview"
              aria-label="Truck detail"
            />
          }
        />
      </div>
    </div>
  );
}
