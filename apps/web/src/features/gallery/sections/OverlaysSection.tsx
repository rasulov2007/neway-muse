import {
  Archive,
  Copy,
  Ellipsis,
  ExternalLink,
  Info,
  Pencil,
  Send,
  Settings2,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import {
  Button,
  ConfirmDialog,
  Drawer,
  DropdownMenu,
  FormField,
  IconButton,
  Input,
  MenuCheckboxItem,
  MenuItem,
  MenuLabel,
  MenuSeparator,
  Modal,
  Popover,
  PopoverClose,
  PopoverContent,
  PopoverTrigger,
  Select,
  StatusBadge,
  Tabs,
  TabsContent,
  Timeline,
  Tooltip,
  useToast,
  type DrawerSize,
  type ModalSize,
} from '@/design-system';
import { formatDateTime, formatMiles, formatMoney } from '@/lib/format';
import { galleryTimeline, heroLoad, heroTruck } from '../galleryData';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

function MenuExample() {
  const [showInactive, setShowInactive] = useState(true);
  const [showSold, setShowSold] = useState(false);
  return (
    <DropdownMenu
      trigger={
        <Button variant="secondary" iconRight={<Ellipsis />}>
          Truck actions
        </Button>
      }
    >
      <MenuLabel>Unit 2785</MenuLabel>
      <MenuItem icon={<Pencil />} shortcut="E">
        Edit truck
      </MenuItem>
      <MenuItem icon={<UserPlus />} shortcut="A">
        Assign driver
      </MenuItem>
      <MenuItem icon={<Copy />} shortcut="⌘C">
        Copy VIN
      </MenuItem>
      <MenuItem icon={<Send />} disabled>
        Send to telematics
      </MenuItem>
      <MenuSeparator />
      <MenuLabel>Show</MenuLabel>
      <MenuCheckboxItem
        checked={showInactive}
        onCheckedChange={(v) => setShowInactive(v === true)}
        onSelect={(e) => e.preventDefault()}
      >
        Inactive trucks
      </MenuCheckboxItem>
      <MenuCheckboxItem
        checked={showSold}
        onCheckedChange={(v) => setShowSold(v === true)}
        onSelect={(e) => e.preventDefault()}
      >
        Sold trucks
      </MenuCheckboxItem>
      <MenuSeparator />
      <MenuItem icon={<Archive />}>Archive</MenuItem>
      <MenuItem icon={<Trash2 />} destructive>
        Retire truck
      </MenuItem>
    </DropdownMenu>
  );
}

function ModalExample({ size }: { size: ModalSize }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  return (
    <Modal
      open={open}
      onOpenChange={setOpen}
      size={size}
      title="Assign driver to Unit 2785"
      description="The driver's current unit is released when you save."
      trigger={<Button variant="secondary">Modal · {size}</Button>}
      footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              setOpen(false);
              toast({ tone: 'success', title: 'Driver assigned to Unit 2785' });
            }}
          >
            Assign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label="Driver" required>
          <Select
            options={[
              { value: 'd1', label: 'Marcus Lee' },
              { value: 'd2', label: 'Elena Petrova' },
              { value: 'd3', label: 'Jamal Washington' },
            ]}
            placeholder="Choose a driver"
          />
        </FormField>
        <FormField label="Effective from" description="Defaults to now.">
          <Input defaultValue={formatDateTime(heroTruck.odometerAt)} />
        </FormField>
      </div>
    </Modal>
  );
}

function ConfirmExample({ tone }: { tone: 'default' | 'danger' }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  const danger = tone === 'danger';
  return (
    <>
      <Button variant={danger ? 'danger' : 'secondary'} onClick={() => setOpen(true)}>
        {danger ? 'Retire Unit 3012' : 'Mark L-100245 delivered'}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone={tone}
        title={danger ? 'Retire Unit 3012?' : 'Mark load delivered?'}
        description={
          danger
            ? 'This removes the truck from dispatch and every future load. Maintenance history is kept.'
            : 'The load moves to Delivered and the invoice becomes ready to issue.'
        }
        confirmLabel={danger ? 'Retire truck' : 'Mark delivered'}
        onConfirm={async () => {
          await new Promise((r) => setTimeout(r, 700));
          toast({
            tone: danger ? 'warning' : 'success',
            title: danger ? 'Unit 3012 retired' : 'L-100245 marked delivered',
          });
        }}
      />
    </>
  );
}

function DrawerExample({ size }: { size: DrawerSize }) {
  const [open, setOpen] = useState(false);
  const { toast } = useToast();
  return (
    <Drawer
      open={open}
      onOpenChange={setOpen}
      size={size}
      title={`Load ${heroLoad.loadNumber}`}
      description={`${heroLoad.origin.city}, ${heroLoad.origin.state} → ${heroLoad.destination.city}, ${heroLoad.destination.state}`}
      headerExtra={<StatusBadge status={heroLoad.status} />}
      trigger={
        <Button variant="secondary" icon={<ExternalLink />}>
          Drawer · {size}
        </Button>
      }
      onOpenFullPage={() => {
        setOpen(false);
        toast({ tone: 'info', title: `Opens /loads/${heroLoad.loadNumber}` });
      }}
      tabs={
        <Tabs
          items={[
            { value: 'summary', label: 'Summary' },
            { value: 'timeline', label: 'Timeline', count: galleryTimeline.length },
            { value: 'financials', label: 'Financials' },
          ]}
          defaultValue="summary"
          size="sm"
          aria-label="Load"
          listClassName="border-b-0"
        >
          <TabsContent value="summary" className="sr-only">
            Summary
          </TabsContent>
        </Tabs>
      }
      footer={
        <>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
          <Button variant="primary">Edit load</Button>
        </>
      }
    >
      <dl className="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-2 text-sm">
        <dt className="text-muted">Customer</dt>
        <dd className="text-ink">{heroLoad.customerName}</dd>
        <dt className="text-muted">Broker</dt>
        <dd className="text-ink">{heroLoad.brokerName ?? '—'}</dd>
        <dt className="text-muted">Driver</dt>
        <dd className="text-ink">{heroLoad.driverName ?? 'Unassigned'}</dd>
        <dt className="text-muted">Truck</dt>
        <dd className="text-ink">{heroLoad.truckUnit ? `Unit ${heroLoad.truckUnit}` : '—'}</dd>
        <dt className="text-muted">Rate</dt>
        <dd className="tabular text-ink">{formatMoney(heroLoad.rate)}</dd>
        <dt className="text-muted">Loaded miles</dt>
        <dd className="tabular text-ink">{formatMiles(heroLoad.loadedMiles)}</dd>
      </dl>
      <h3 className="mt-6 mb-3 text-md font-bold text-ink">Timeline</h3>
      <Timeline
        dense
        items={galleryTimeline.map((e) => ({
          id: e.id,
          at: e.at,
          title: e.title,
          description: e.detail,
          actor: { name: e.actorName },
        }))}
      />
    </Drawer>
  );
}

export function OverlaysSection() {
  return (
    <GallerySection
      id="overlays"
      index={9}
      title="Overlays"
      note="Progressive disclosure: tooltip → popover → drawer → page. Modals are for confirmations and quick create only. All trap focus and close on Esc."
    >
      <ExampleGrid columns={3}>
        <Example caption="Tooltip · top / right / bottom / left (200 ms delay)" row>
          <Tooltip content="Edit truck">
            <IconButton label="Edit" variant="secondary">
              <Pencil />
            </IconButton>
          </Tooltip>
          <Tooltip content="Telematics last updated 2 min ago" side="right">
            <Button variant="secondary" icon={<Info />}>
              Right
            </Button>
          </Tooltip>
          <Tooltip content="Opens the load in a full page" side="bottom">
            <Button variant="secondary">Bottom</Button>
          </Tooltip>
          <Tooltip content="Settings" side="left">
            <IconButton label="Settings" variant="secondary">
              <Settings2 />
            </IconButton>
          </Tooltip>
        </Example>
        <Example
          caption="DropdownMenu · label, icons, shortcuts, disabled, checkbox items, destructive last"
          row
        >
          <MenuExample />
          <DropdownMenu
            align="start"
            trigger={
              <IconButton label="Row actions" variant="secondary">
                <Ellipsis />
              </IconButton>
            }
          >
            <MenuItem icon={<Pencil />}>Edit</MenuItem>
            <MenuItem icon={<Copy />}>Duplicate</MenuItem>
            <MenuSeparator />
            <MenuItem icon={<Trash2 />} destructive>
              Delete
            </MenuItem>
          </DropdownMenu>
        </Example>
        <Example caption="Popover · 288px default, 12px padding" row>
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary">Unit 2785 details</Button>
            </PopoverTrigger>
            <PopoverContent>
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium text-ink">Unit 2785</span>
                  <StatusBadge status={heroTruck.status} size="sm" />
                </div>
                <p className="text-xs text-muted">
                  {heroTruck.year} {heroTruck.make} {heroTruck.model} ·{' '}
                  {formatMiles(heroTruck.odometer)}
                </p>
                <div className="flex justify-end gap-2 border-t border-line-soft pt-2">
                  <PopoverClose asChild>
                    <Button size="sm" variant="ghost">
                      Close
                    </Button>
                  </PopoverClose>
                  <Button size="sm" variant="primary">
                    Open
                  </Button>
                </div>
              </div>
            </PopoverContent>
          </Popover>
        </Example>
      </ExampleGrid>

      <ExampleGroup title="Dialogs">
        <ExampleGrid columns={3}>
          <Example caption="Modal · sm 420 / md 560 / lg 760" row>
            <ModalExample size="sm" />
            <ModalExample size="md" />
            <ModalExample size="lg" />
          </Example>
          <Example caption="ConfirmDialog · default / danger (async, spinner on confirm)" row>
            <ConfirmExample tone="default" />
            <ConfirmExample tone="danger" />
          </Example>
          <Example
            caption="Drawer · md 480 / lg 640 / xl 800 with tabs, status and “Open full page”"
            row
          >
            <DrawerExample size="md" />
            <DrawerExample size="lg" />
            <DrawerExample size="xl" />
          </Example>
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}
