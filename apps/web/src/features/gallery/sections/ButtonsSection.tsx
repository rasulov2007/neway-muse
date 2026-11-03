import {
  ArrowRight,
  Download,
  Ellipsis,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import { Button, IconButton, type ButtonSize, type ButtonVariant } from '@/design-system';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

const variants: { variant: ButtonVariant; label: string }[] = [
  { variant: 'primary', label: 'Create load' },
  { variant: 'secondary', label: 'Export' },
  { variant: 'ghost', label: 'Cancel' },
  { variant: 'danger', label: 'Delete truck' },
  { variant: 'link', label: 'View all loads' },
];

const sizes: ButtonSize[] = ['sm', 'md', 'lg'];

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function ButtonsSection() {
  return (
    <GallerySection
      id="buttons"
      index={2}
      title="Buttons"
      note="One primary per view. Secondary for everything else, ghost for quiet actions, danger only inside destructive confirms, link inline in text."
    >
      <ExampleGroup title="Variants × sizes">
        <ExampleGrid columns={1}>
          {sizes.map((size) => (
            <Example
              key={size}
              caption={`Size ${size} · ${size === 'sm' ? 28 : size === 'md' ? 32 : 36}px`}
              row
            >
              {variants.map((v) => (
                <Button key={v.variant} variant={v.variant} size={size}>
                  {v.label}
                </Button>
              ))}
            </Example>
          ))}
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="With icons">
        <ExampleGrid columns={2}>
          <Example caption="Icon left · every variant" row>
            <Button variant="primary" icon={<Plus />}>
              Add truck
            </Button>
            <Button variant="secondary" icon={<Download />}>
              Export CSV
            </Button>
            <Button variant="ghost" icon={<RefreshCw />}>
              Refresh
            </Button>
            <Button variant="danger" icon={<Trash2 />}>
              Delete
            </Button>
            <Button variant="link" icon={<Search />}>
              Search loads
            </Button>
          </Example>
          <Example caption="Icon right" row>
            <Button variant="primary" iconRight={<ArrowRight />}>
              Dispatch load L-100245
            </Button>
            <Button variant="secondary" iconRight={<ArrowRight />}>
              Next stop
            </Button>
            <Button variant="link" iconRight={<ArrowRight />}>
              Open full page
            </Button>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="States">
        <ExampleGrid columns={3}>
          <Example caption="Loading · spinner replaces the icon, button is disabled" row>
            {variants
              .filter((v) => v.variant !== 'link')
              .map((v) => (
                <Button key={v.variant} variant={v.variant} loading>
                  {v.variant === 'primary' ? 'Saving…' : titleCase(v.variant)}
                </Button>
              ))}
          </Example>
          <Example caption="Disabled · 50% opacity, no pointer events" row>
            {variants.map((v) => (
              <Button key={v.variant} variant={v.variant} disabled>
                {titleCase(v.variant)}
              </Button>
            ))}
          </Example>
          <Example caption="Full width · forms and drawers">
            <Button variant="primary" fullWidth icon={<Plus />}>
              Schedule maintenance for Unit 2785
            </Button>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="IconButton">
        <ExampleGrid columns={3}>
          <Example caption="Ghost (default) · sm / md / lg" row>
            <IconButton label="Row actions" size="sm">
              <Ellipsis />
            </IconButton>
            <IconButton label="Row actions" size="md">
              <Ellipsis />
            </IconButton>
            <IconButton label="Row actions" size="lg">
              <Ellipsis />
            </IconButton>
          </Example>
          <Example caption="Other variants" row>
            <IconButton label="Add" variant="primary">
              <Plus />
            </IconButton>
            <IconButton label="Edit" variant="secondary">
              <Pencil />
            </IconButton>
            <IconButton label="Delete" variant="danger">
              <Trash2 />
            </IconButton>
          </Example>
          <Example caption="Loading · disabled" row>
            <IconButton label="Refreshing" variant="secondary" loading>
              <RefreshCw />
            </IconButton>
            <IconButton label="Close" disabled>
              <X />
            </IconButton>
          </Example>
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}
