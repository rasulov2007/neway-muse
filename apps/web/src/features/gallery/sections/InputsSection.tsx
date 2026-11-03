import { subDays } from 'date-fns';
import { DollarSign, Mail, Search } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import {
  Checkbox,
  Combobox,
  DatePicker,
  DateRangePicker,
  FormField,
  Input,
  RadioGroup,
  Select,
  Switch,
  Textarea,
  type CheckedState,
  type ComboboxOption,
  type DateRange,
} from '@/design-system';
import { brokerOptions, driverOptions, truckOptions, GALLERY_NOW } from '../galleryData';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

const equipmentOptions = [
  { value: 'dry_van', label: 'Dry van' },
  { value: 'reefer', label: 'Reefer' },
  { value: 'flatbed', label: 'Flatbed' },
  { value: 'tanker', label: 'Tanker', disabled: true },
];

const ownershipOptions = [
  { value: 'owned', label: 'Company owned', description: 'On the company title and insurance.' },
  { value: 'leased', label: 'Leased', description: 'Lease payments tracked as a fixed expense.' },
  { value: 'owner_operator', label: 'Owner-operator', description: 'Settled per load.' },
  { value: 'rental', label: 'Rental', disabled: true },
];

const ASYNC_LATENCY_MS = 500;

/** Combobox with a simulated async driver search. */
function AsyncDriverCombobox() {
  const [value, setValue] = useState<string | null>(null);
  const [options, setOptions] = useState<ComboboxOption[]>(driverOptions);
  const [loading, setLoading] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function search(query: string) {
    if (timer.current) clearTimeout(timer.current);
    setLoading(true);
    timer.current = setTimeout(() => {
      const q = query.trim().toLowerCase();
      setOptions(
        q ? driverOptions.filter((o) => o.label.toLowerCase().includes(q)) : driverOptions,
      );
      setLoading(false);
    }, ASYNC_LATENCY_MS);
  }

  return (
    <Combobox
      aria-label="Driver (async)"
      options={options}
      value={value}
      onValueChange={setValue}
      onSearch={search}
      loading={loading}
      placeholder="Search drivers…"
      searchPlaceholder="Type a driver name"
    />
  );
}

export function InputsSection() {
  const [driver, setDriver] = useState<string | null>(driverOptions[0]?.value ?? null);
  const [trucks, setTrucks] = useState<string[]>(truckOptions.slice(0, 2).map((t) => t.value));
  const [indeterminate, setIndeterminate] = useState<CheckedState>('indeterminate');
  const [ownership, setOwnership] = useState('owned');
  const [date, setDate] = useState<Date | undefined>(GALLERY_NOW);
  const [range, setRange] = useState<DateRange | undefined>({
    from: subDays(GALLERY_NOW, 6),
    to: GALLERY_NOW,
  });

  return (
    <GallerySection
      id="inputs"
      index={3}
      title="Inputs"
      note="32px controls by default (28 sm, 36 lg). Border line-strong, focus ring from tokens, invalid state from aria-invalid so FormField wires it automatically."
    >
      <ExampleGroup title="Input">
        <ExampleGrid columns={3}>
          <Example caption="Sizes · sm / md / lg">
            <div className="flex flex-col gap-3">
              <Input size="sm" placeholder="Unit number" aria-label="Unit number (sm)" />
              <Input size="md" placeholder="Unit number" aria-label="Unit number (md)" />
              <Input size="lg" placeholder="Unit number" aria-label="Unit number (lg)" />
            </div>
          </Example>
          <Example caption="Prefix and suffix">
            <div className="flex flex-col gap-3">
              <Input
                prefix={<Search />}
                placeholder="Search trucks, loads, drivers…"
                aria-label="Search"
              />
              <Input prefix={<DollarSign />} defaultValue="3,250.00" aria-label="Rate" />
              <Input suffix="mi" defaultValue="642" inputMode="numeric" aria-label="Loaded miles" />
              <Input
                prefix={<Mail />}
                suffix="@neway.example.com"
                defaultValue="dispatch"
                aria-label="Email"
              />
            </div>
          </Example>
          <Example caption="Filled · Invalid · Disabled">
            <div className="flex flex-col gap-3">
              <Input defaultValue="2785" aria-label="Filled" />
              <Input invalid defaultValue="1FUJGLDR5LLAB12" aria-label="Invalid VIN" />
              <Input disabled defaultValue="Freightliner Cascadia" aria-label="Disabled" />
              <Input
                disabled
                prefix={<Search />}
                placeholder="Disabled with prefix"
                aria-label="Disabled with prefix"
              />
            </div>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Textarea, Select">
        <ExampleGrid columns={3}>
          <Example caption="Textarea · default / invalid / disabled">
            <div className="flex flex-col gap-3">
              <Textarea
                aria-label="Dispatch notes"
                placeholder="Dispatch notes for the driver…"
                defaultValue="Check in at gate 4. Lumper fee is prepaid; keep the receipt for L-100245."
              />
              <Textarea aria-label="Invalid notes" invalid rows={2} defaultValue="Too short" />
              <Textarea
                aria-label="Disabled notes"
                disabled
                rows={2}
                defaultValue="Locked after delivery."
              />
            </div>
          </Example>
          <Example caption="Select · sizes with a disabled option">
            <div className="flex flex-col gap-3">
              <Select
                size="sm"
                aria-label="Equipment (sm)"
                options={equipmentOptions}
                placeholder="Equipment"
              />
              <Select
                aria-label="Equipment (md)"
                options={equipmentOptions}
                defaultValue="reefer"
              />
              <Select
                size="lg"
                aria-label="Equipment (lg)"
                options={equipmentOptions}
                placeholder="Equipment"
              />
            </div>
          </Example>
          <Example caption="Select · invalid / disabled">
            <div className="flex flex-col gap-3">
              <Select
                aria-label="Invalid select"
                options={equipmentOptions}
                placeholder="Choose equipment"
                invalid
              />
              <Select
                aria-label="Disabled select"
                options={equipmentOptions}
                defaultValue="dry_van"
                disabled
              />
            </div>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Combobox">
        <ExampleGrid columns={2}>
          <Example caption="Single · driver with description line">
            <Combobox
              aria-label="Driver"
              options={driverOptions}
              value={driver}
              onValueChange={setDriver}
              placeholder="Select a driver"
            />
          </Example>
          <Example caption="Multiple · trucks as chips">
            <Combobox
              multiple
              aria-label="Trucks"
              options={truckOptions}
              value={trucks}
              onValueChange={setTrucks}
              placeholder="Add trucks"
            />
          </Example>
          <Example caption="Async · loading while searching (500 ms)">
            <AsyncDriverCombobox />
          </Example>
          <Example caption="Invalid / disabled">
            <div className="flex flex-col gap-3">
              <Combobox
                aria-label="Invalid broker"
                options={brokerOptions}
                placeholder="Broker"
                invalid
              />
              <Combobox
                aria-label="Disabled broker"
                options={brokerOptions}
                value={brokerOptions[0]?.value}
                disabled
              />
            </div>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Checkbox, Radio, Switch">
        <ExampleGrid columns={3}>
          <Example caption="Checkbox · unchecked / checked / indeterminate / disabled / invalid">
            <div className="flex flex-col gap-3">
              <Checkbox
                label="Hazmat load"
                description="Adds placards and the HM endorsement check."
              />
              <Checkbox label="Team drivers" defaultChecked />
              <Checkbox
                label="Select all trucks"
                description="3 of 25 selected"
                checked={indeterminate}
                onCheckedChange={setIndeterminate}
              />
              <Checkbox label="Locked after invoicing" disabled defaultChecked />
              <Checkbox label="Accept the rate confirmation" invalid />
              <Checkbox aria-label="Bare checkbox for tables" />
            </div>
          </Example>
          <Example caption="RadioGroup · vertical with descriptions">
            <RadioGroup
              label="Ownership"
              options={ownershipOptions}
              value={ownership}
              onValueChange={setOwnership}
            />
          </Example>
          <Example caption="RadioGroup · horizontal / invalid, Switch states">
            <div className="flex flex-col gap-4">
              <RadioGroup
                label="Trailer type"
                orientation="horizontal"
                defaultValue="reefer"
                options={equipmentOptions.slice(0, 3)}
              />
              <RadioGroup
                label="Priority"
                invalid
                defaultValue=""
                orientation="horizontal"
                options={[
                  { value: 'normal', label: 'Normal' },
                  { value: 'urgent', label: 'Urgent' },
                ]}
              />
              <div className="flex flex-col gap-3 border-t border-line-soft pt-4">
                <Switch
                  label="Telematics sync"
                  description="Pull location from Samsara every 60 s."
                  defaultChecked
                />
                <Switch label="Email notifications" />
                <Switch label="Auto-dispatch" disabled defaultChecked />
                <Switch aria-label="Bare switch" />
              </div>
            </div>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Date pickers">
        <ExampleGrid columns={3}>
          <Example caption="DatePicker · value / empty / invalid / disabled">
            <div className="flex flex-col gap-3">
              <DatePicker aria-label="Next service date" value={date} onChange={setDate} />
              <DatePicker aria-label="Empty date" placeholder="Pick a date" />
              <DatePicker aria-label="Invalid date" invalid placeholder="Required" />
              <DatePicker aria-label="Disabled date" disabled value={GALLERY_NOW} />
            </div>
          </Example>
          <Example caption="DateRangePicker · presets: Today, Yesterday, Last 7 / 30 days, This / Last month">
            <div className="flex flex-col gap-3">
              <DateRangePicker aria-label="Report range" value={range} onChange={setRange} />
              <DateRangePicker aria-label="Empty range" />
              <DateRangePicker
                aria-label="Small range"
                size="sm"
                value={{ from: subDays(GALLERY_NOW, 29), to: GALLERY_NOW }}
              />
            </div>
          </Example>
          <Example caption="Sizes · sm / lg">
            <div className="flex flex-col gap-3">
              <DatePicker aria-label="Small date" size="sm" value={GALLERY_NOW} />
              <DatePicker aria-label="Large date" size="lg" value={GALLERY_NOW} />
            </div>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="FormField">
        <ExampleGrid columns={3}>
          <Example caption="Label + description">
            <FormField
              label="Unit number"
              description="2–8 characters; shown everywhere the truck appears."
            >
              <Input placeholder="2790" />
            </FormField>
          </Example>
          <Example caption="Required">
            <FormField label="VIN" required description="17 characters, no I, O or Q.">
              <Input placeholder="1FUJGLDR5LLAB1234" className="font-mono uppercase" />
            </FormField>
          </Example>
          <Example caption="Error · replaces the description and sets aria-invalid on the control">
            <FormField
              label="Odometer"
              required
              description="Miles as shown on the dash."
              error="Odometer must be higher than the last reading (421,500 mi)."
            >
              <Input defaultValue="418,200" suffix="mi" />
            </FormField>
          </Example>
          <Example caption="Wrapping a Select">
            <FormField label="Equipment" required>
              <Select options={equipmentOptions} placeholder="Choose equipment" />
            </FormField>
          </Example>
          <Example caption="Wrapping a DatePicker with error">
            <FormField label="Scheduled for" error="Pick a date in the future.">
              <DatePicker value={subDays(GALLERY_NOW, 3)} />
            </FormField>
          </Example>
          <Example caption="Wrapping a Textarea">
            <FormField label="Notes" description="Visible to the driver in the app.">
              <Textarea rows={2} placeholder="Gate code, dock hours, contacts…" />
            </FormField>
          </Example>
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}
