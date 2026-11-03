import { useState } from 'react';
import { Badge, Button, Drawer, Tabs } from '@/design-system';
import { hrefs, useGo } from '@/features/dashboard/links';
import { DRIVER_AVAILABILITY_LABEL, DRIVER_AVAILABILITY_TONE } from './operations-ui';
import { ComplianceTab, LoadsTab, OverviewTab, PerformanceTab } from './DriverSections';
import type { OperationalDriver } from './useOperations';

const TABS = [
  { value: 'overview', label: 'Overview' },
  { value: 'loads', label: 'Loads' },
  { value: 'performance', label: 'Performance' },
  { value: 'compliance', label: 'Compliance' },
] as const;

type DriverTab = (typeof TABS)[number]['value'];

export interface DriverDrawerProps {
  /** Already resolved by the page from `?driver=`; the drawer is open while it is set. */
  driver: OperationalDriver | null;
  onClose: () => void;
}

/**
 * One driver as Operations sees them: whether they can run, what they are running, what their work
 * earned, and what Safety says about them. Nothing here is derived — every verdict comes from the
 * operations bundle, so the drawer cannot contradict the board behind it.
 */
export function DriverDrawer({ driver, onClose }: DriverDrawerProps) {
  const go = useGo();
  const open = driver !== null;

  // The active tab resets whenever a different driver opens (same trick as TruckDrawer).
  const [tabState, setTabState] = useState<{ id: string | null; tab: DriverTab }>({
    id: null,
    tab: 'overview',
  });
  const id = driver?.driver.id ?? null;
  const tab = tabState.id === id ? tabState.tab : 'overview';
  const setTab = (next: DriverTab) => setTabState({ id, tab: next });

  const unit = driver?.driver.currentTruckUnit ?? null;
  const currentLoad = driver?.currentLoad ?? null;

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      size="lg"
      title={driver?.driver.name ?? ''}
      description={
        driver
          ? `Driver ${driver.driver.driverNumber} · ${DRIVER_AVAILABILITY_LABEL[driver.availability.state]}`
          : undefined
      }
      headerExtra={
        driver ? (
          <Badge tone={DRIVER_AVAILABILITY_TONE[driver.availability.state]} size="sm">
            {DRIVER_AVAILABILITY_LABEL[driver.availability.state]}
          </Badge>
        ) : null
      }
      tabs={
        driver ? (
          <Tabs
            items={[...TABS]}
            value={tab}
            onValueChange={(next) => setTab(next as DriverTab)}
            size="sm"
            aria-label="Driver sections"
            listClassName="-mb-px border-b-0"
          />
        ) : null
      }
      footer={
        driver ? (
          // Only actions that have a destination are offered; an "Open unit" button for a driver
          // with no truck would be a dead end.
          <div className="flex flex-wrap gap-2">
            {currentLoad ? (
              <Button size="sm" onClick={() => go(hrefs.load(currentLoad.loadNumber))}>
                Open current load
              </Button>
            ) : null}
            {unit ? (
              <Button variant="secondary" size="sm" onClick={() => go(hrefs.truck(unit))}>
                Open unit
              </Button>
            ) : null}
            {unit ? (
              <Button variant="secondary" size="sm" onClick={() => go(hrefs.trackUnit(unit))}>
                Open tracking
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => go(hrefs.safety)}>
              Open safety
            </Button>
          </div>
        ) : null
      }
      bodyClassName="bg-app"
    >
      {driver ? (
        <div className="flex flex-col gap-4">
          {tab === 'overview' ? <OverviewTab row={driver} /> : null}
          {tab === 'loads' ? <LoadsTab row={driver} /> : null}
          {tab === 'performance' ? <PerformanceTab row={driver} /> : null}
          {tab === 'compliance' ? <ComplianceTab row={driver} /> : null}
        </div>
      ) : null}
    </Drawer>
  );
}
