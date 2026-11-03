# NEWAY TMS — Design System Contract

The visual foundation every module is built on. Written before the components so that everything is built to one set of rules. Phase 2 implements this; every later phase consumes it and never re-invents a component.

Related: [ARCHITECTURE.md](../ARCHITECTURE.md) §17 · tokens in `apps/web/src/design-system/tokens.css`

---

## 1. Direction

**Complex system, simple interface.** Premium enterprise SaaS in the spirit of Linear, Stripe, and Ramp applied to transportation operations. Clean, classic, calm, fast, consistent. An operational tool a dispatcher can use for eight hours.

Rules that follow from that:

1. Light interface. Page background very light neutral; content on white surfaces with a 1px border and at most a whisper of shadow. Small radii (4–8 px). No floating-bubble cards.
2. Hierarchy through typography and spacing, not color or decoration. Titles are modest (20 px page title). Eyebrow labels for sections.
3. Color is semantic and scarce: blue = action/information, green = healthy/success, orange = warning, red = critical, gray = neutral/inactive. Purple only for secondary categorization. No other hues in UI chrome.
4. Progressive disclosure: list → drawer → page with tabs. Never everything at once.
5. Density tuned for operations: 40 px table rows (34 px dense), 32 px controls, 13–14 px text.
6. Status is one system everywhere (§6). Badges are small and quiet.
7. Every data view has designed loading, empty, and error states.
8. Subtle motion only: 100–240 ms, standard easing, respects reduced motion.
9. Accessible by construction: Radix primitives for overlays/menus/tabs/selects/checkbox/radio, visible focus, labels, keyboard paths, never color alone.
10. One icon set: Lucide, 16 px in controls and nav, 20 px in empty states, stroke 1.75.

---

## 2. Tokens (see `tokens.css`)

| Group | Tokens |
|---|---|
| Surfaces | `app`, `surface`, `surface-muted`, `surface-hover`, `surface-active`, `sidebar`, `sidebar-hover`, `overlay` |
| Lines | `line`, `line-strong`, `line-soft` |
| Text | `ink`, `secondary`, `muted`, `faint`, `inverse` |
| Action | `primary`, `primary-hover`, `primary-active`, `primary-soft`, `primary-soft-hover`, `primary-border`, `primary-text`, `focus` |
| Status | `success`, `warning`, `danger`, `info`, `neutral`, each with `-soft`, `-border`, `-text`; `accent` (purple) sparingly |
| Type | `text-2xs` 11 · `xs` 12 · `sm` 13 · `base` 14 · `md` 15 · `lg` 16 · `xl` 18 · `2xl` 20 · `3xl` 24; weights 400/500/600 only |
| Radius | `xs` 3 · `sm` 4 · `md` 6 · `lg` 8 · `xl` 10 · `full` |
| Shadow | `xs`, `sm` (cards), `md` (popovers), `lg` (drawers/modals), `focus` |
| Motion | `duration-fast` 100 · `base` 150 · `slow` 240; `ease-standard`, `ease-out` |
| Layout | sidebar 248 / 60 collapsed, topbar 52, content max 1600, page padding 24, section gap 24, card padding 16, row 40 / 34 dense, controls 28 / 32 / 36 |
| Charts | `--chart-series-1..8` (validated categorical order), `--chart-seq-1..7`, `--chart-good/warning/serious/critical`, `--chart-grid`, `--chart-axis` |

Usage: Tailwind utilities generated from `@theme` (`bg-surface`, `text-secondary`, `border-line`, `bg-primary`, `text-danger-text`, `rounded-md`, `shadow-sm`, `text-sm`). Raw hex or px values in components are a review failure.

### Typography hierarchy

| Role | Class | Size / weight / color |
|---|---|---|
| Page title | `text-2xl font-semibold text-ink tracking-tight` | 20 / 600 |
| Page description | `text-sm text-muted` | 13 / 400 |
| Section title | `text-base font-semibold text-ink` | 14 / 600 |
| Eyebrow | `.eyebrow` | 11 / 600 / uppercase / muted |
| Table header | `text-xs font-medium text-muted uppercase tracking-eyebrow` | 12 / 500 |
| Body | `text-base text-ink` | 14 / 400 |
| Secondary | `text-sm text-secondary` | 13 |
| Metadata | `text-xs text-muted` | 12 |
| Numbers | add `.tabular` | tabular figures |

---

## 3. Layout and shell

```
┌ Sidebar (248 / 60) ┬ Topbar (52) ──────────────────────────────────────────┐
│ Brand              │ [Company ▾]   [Search anything…  ⌘K]     🔔  ?  [User ▾] │
│ COMPANY            ├───────────────────────────────────────────────────────────┤
│  Dashboard         │ Breadcrumb                                                │
│  AI Command Center │ Page title                        [secondary] [primary]   │
│  Notifications     │ Page description                                          │
│ OPERATIONS         │ ─────────────────────────────────────────────────────────│
│  Dispatch …        │ content (max 1600, padding 24, section gap 24)            │
└────────────────────┴───────────────────────────────────────────────────────────┘
```

- **Sidebar**: light surface, 1px right border. Groups with eyebrow labels; items 32 px tall, 16 px icon, 13 px label; active item = `primary-soft` background + `primary-text` + 2 px left indicator; hover = `sidebar-hover`. Second level (e.g. Maintenance → Overview / Due Soon / Overdue / Scheduled / Completed) renders indented under the active item only. Collapse to 60 px icons with tooltips; state persisted in `localStorage`; below `lg` the sidebar is a slide-over sheet opened from the topbar. Keyboard: arrow navigation, `[` toggles collapse.
- **Topbar**: white, 1px bottom border. Left: mobile menu button, company selector (name + chevron; the selector lists only the user's memberships and shows the active company prominently; switching triggers a confirmation-free but explicit page reload of data and a toast "Switched to X"). Center: search field that opens the command palette (`⌘K` / `Ctrl+K`). Right: notifications (badge count, opens panel), help, user menu (profile, preferences, sign out).
- **Page header**: breadcrumb (`Fleet / Trucks / Unit 2785`), title, optional description, actions on the right (at most one primary). Optional tab strip below.
- **Content**: cards only when grouping is needed; tables sit directly on a bordered surface. Two-column layouts at `xl+`, single column below.

---

## 4. Components (contract)

All components live in `apps/web/src/design-system/components/`, one folder per component with `index.ts`, the component, and a test. Exported from `design-system/index.ts`. Props are minimal and typed; variants use a `variant`/`size`/`tone` vocabulary consistently. `className` is accepted and merged with `cn()` (clsx + tailwind-merge).

| Component | Props / variants | Notes |
|---|---|---|
| `Button` | `variant: primary \| secondary \| ghost \| danger \| link`; `size: sm \| md \| lg`; `icon`, `iconRight`, `loading`, `disabled`, `asChild` | Primary is solid blue; secondary is white with border; ghost is text; danger is solid red used only for destructive confirms |
| `IconButton` | same variants; `label` (required, for aria) | Square, tooltip on hover |
| `Input` | `size`, `prefix`, `suffix`, `invalid`, `disabled` | 32 px; border `line-strong`; focus ring |
| `Textarea` | `rows`, `invalid` | |
| `Select` | Radix Select; `options`, `placeholder`, `size`, `invalid` | Native-feeling, keyboard-typeahead |
| `Combobox` | cmdk-based; `options`, `onSearch`, `loading`, `multiple` | Async search for drivers/trucks/customers |
| `Checkbox`, `Radio`, `RadioGroup`, `Switch` | Radix; `label`, `description` | |
| `DatePicker`, `DateRangePicker` | react-day-picker in a Popover; `value`, `onChange`, presets | Presets: Today, Last 7 days, Last 30 days, This month, Custom |
| `FormField` | `label`, `description`, `error`, `required`, `htmlFor` | Wraps any control; inline validation text in `danger-text` |
| `Form` helpers | `useZodForm(schema)`; `FormSection` (`title`, `description`) | react-hook-form + zod resolver |
| `Badge` | `tone: neutral \| info \| success \| warning \| danger \| accent`; `variant: soft \| outline`; `size: sm \| md`; `dot` | 20 px tall, 11–12 px text; never the only carrier of meaning (label text always present) |
| `StatusBadge` | `status: StatusCode` | Maps through the status system (§6); adds icon for warning/danger |
| `Avatar` | `name`, `src`, `size` | Initials fallback, neutral background |
| `Tooltip` | Radix; `content`, `side` | 200 ms delay |
| `DropdownMenu` | Radix; `items` or composition; `MenuItem` with `icon`, `destructive`, `shortcut` | |
| `Popover` | Radix | |
| `Tabs` | Radix; `variant: underline \| segmented`; `items {value,label,count?}`; controlled/uncontrolled; URL-synced helper | Underline for page tabs; segmented for filters |
| `Card` | `title`, `description`, `actions`, `padding: none \| sm \| md`, `footer` | Border + `shadow-xs`; no hover lift unless `interactive` |
| `KpiCard` | `label`, `value`, `delta {value, direction, label}`, `icon`, `hint`, `loading`, `onClick` | Compact: label (eyebrow), value (24 px), delta (12 px with arrow + tone), optional sparkline slot |
| `DataTable` | TanStack Table; `columns`, `data`, `rowKey`, `state` (sort, pagination, selection, columnVisibility, globalFilter), `onStateChange`, `serverSide` flag, `loading`, `empty`, `error`, `dense`, `stickyHeader`, `rowActions`, `bulkActions`, `onRowClick`, `virtualize` | Toolbar slot (search, filters, column chooser, export), footer pagination; skeleton rows when loading; empty and error states inline |
| `Pagination` | `page`, `pageSize`, `total`, `onChange`, `pageSizes` | "1–25 of 377" + prev/next + size select |
| `FilterBar` | `search`, `filters[] {key,label,type,options}`, `values`, `onChange`, `onClear` | Renders chips for active filters |
| `Drawer` | Radix Dialog; `side: right`; `size: md 480 \| lg 640 \| xl 800`; `title`, `description`, `tabs`, `footer`, `onOpenFullPage` | Right-side detail panel; ESC and overlay close; focus trapped |
| `Modal` | Radix Dialog; `size: sm \| md \| lg`; `title`, `description`, `footer` | Confirmations and quick create only |
| `ConfirmDialog` | `title`, `description`, `confirmLabel`, `tone: default \| danger`, `onConfirm`, async-aware | |
| `Toast` | `useToast()`; `tone`; `title`, `description`, `action` | Bottom-right, 5 s, stacked, dismissible |
| `Alert` | `tone`, `title`, `description`, `actions`, `dismissible` | Inline banner; icon per tone |
| `Breadcrumb` | `items {label, href?}` | Last item is current page |
| `PageHeader` | `title`, `description`, `breadcrumb`, `actions`, `tabs`, `meta` | |
| `Timeline` | `items {at, title, description?, tone?, icon?, actor?}`; `dense` | Vertical line, dot per item, relative + absolute time |
| `ActivityFeed` | `items {actor, action, target, at}` | Compact sentence rows with avatar |
| `Skeleton` | `variant: text \| block \| circle`; `lines` | Plus `TableSkeleton`, `KpiSkeleton`, `CardSkeleton` presets |
| `EmptyState` | `icon`, `title`, `description`, `action`, `secondaryAction`, `size` | Never a blank panel |
| `ErrorState` | `title`, `description`, `onRetry`, `error` (details shown only in dev) | Human message first |
| `ChartContainer` | `title`, `description`, `legend`, `height`, `loading`, `empty`, `toolbar` | Wraps Recharts; enforces palette, grid, axis, tooltip styles from tokens |
| `LineChart`, `BarChart`, `AreaChart`, `DonutChart`, `Sparkline` | thin wrappers over Recharts using `ChartContainer` and the series tokens | One y-axis only; direct labels when ≤ 4 series; legend for ≥ 2 |
| `CommandPalette` | cmdk; groups: Pages, Trucks, Trailers, Drivers, Loads, Customers, Brokers, Invoices, Employees, Actions; `⌘K` | Results show entity type, primary label, secondary (e.g., "Freightliner Cascadia · Active") |
| `NotificationCenter` | panel with tabs All / Unread; items with severity icon, title, body, time, entity link; mark read, mark all read | |
| `Sidebar`, `Topbar`, `AppShell`, `CompanySelector`, `UserMenu` | shell pieces (§3) | |

Sizes: `sm` 28 px, `md` 32 px (default), `lg` 36 px for all controls.

---

## 5. Data views

- **Tables**: dense but readable; header 36 px, `surface-muted` background, 12 px uppercase labels; rows 40 px with `line-soft` separators; hover `surface-hover`; selected row `primary-soft`. Numeric columns right-aligned and tabular. Primary column is a link-styled cell. Row actions in a trailing `⋯` menu. Bulk selection with a checkbox column; a bulk action bar replaces the toolbar when rows are selected. Column chooser, sorting indicators, and pagination footer standard. Long tables virtualize above 200 rows.
- **Drawers vs pages**: drawer for a quick read of a single entity (truck, driver, invoice); page for the entity's full detail with tabs (load, truck, driver, employee). The drawer always offers "Open full page".
- **Forms**: sections with a title and short description; two-column grid at `lg+`; labels above inputs; required marker `*`; helper text under the field; inline error under the field; primary action bottom-right of the form (or modal footer); destructive actions never adjacent to primary.
- **Dashboards**: KPI row (6 compact cards) → two-up panels (fleet health donut, load status bar, revenue/profit trend line, critical alerts list) → three-up lists (at-risk loads, upcoming maintenance, safety alerts, pending tasks) → activity/recent tables. No card without a purpose; lists show at most 5–8 rows with "View all".

---

## 6. Status system

One map, `design-system/status.ts`, used by `StatusBadge`, table cells, drawers, and charts. Each status has a canonical code, a label, a tone, and an optional icon. Tones use the reserved semantic colors only.

| Tone | Statuses |
|---|---|
| success (green) | `active`, `available`, `delivered`, `completed`, `paid`, `healthy`, `passed`, `on_time`, `verified`, `connected` |
| info (blue) | `booked`, `assigned`, `dispatched`, `in_transit`, `driving`, `scheduled`, `issued`, `sent`, `in_progress`, `open` |
| warning (orange) | `at_pickup`, `at_delivery`, `loading`, `unloading`, `due_soon`, `expiring`, `delayed`, `pending`, `on_hold`, `partially_paid`, `needs_attention`, `idle` |
| danger (red) | `overdue`, `expired`, `out_of_service`, `critical`, `problem`, `failed`, `disputed`, `accident`, `suspended`, `missing` |
| neutral (gray) | `draft`, `inactive`, `cancelled`, `tonu`, `closed`, `void`, `off_duty`, `sleeper`, `sold`, `terminated`, `unknown`, `disconnected` |
| accent (purple) | `in_shop`, `maintenance` |

Rendering: soft background + colored text + 6 px dot (or icon for warning/danger). Uppercase 11 px or sentence-case 12 px, chosen once per context (tables use sentence case). Never a large filled badge.

---

## 7. Feedback states

| State | Rule |
|---|---|
| Loading | Skeletons matching the final layout (table rows, KPI blocks, card lines). Never a spinner replacing a page; spinners only inside buttons |
| Empty | Icon, one-line title, one-line explanation, primary action when the user can create the thing |
| Error | Human title ("Unable to load fleet data"), one line of context, Retry button; technical detail collapsible in development only |
| Success | Toast, not a modal |
| Destructive | ConfirmDialog with the consequence spelled out and a danger button |

---

## 8. Accessibility

- All interactive elements are native buttons/links or Radix primitives; visible `:focus-visible` ring from tokens.
- Every icon-only control has an accessible name; every input has a label; errors are linked with `aria-describedby`.
- Status is never color alone: text label always, icon for warning/danger.
- Tables use `<table>` semantics, sortable headers are buttons with `aria-sort`, row selection checkboxes are labeled.
- Drawers and modals trap focus and restore it on close; ESC closes.
- Keyboard: sidebar arrows, `⌘K` palette, `[` collapse sidebar, `Esc` closes overlays.
- Color contrast ≥ 4.5:1 for text, ≥ 3:1 for large text and UI borders on white.

---

## 9. File layout

```
apps/web/src/
  design-system/
    tokens.css
    index.ts                 # public exports
    lib/cn.ts                # clsx + tailwind-merge
    status.ts                # status map (§6)
    components/<Name>/       # component + test
  app/
    shell/                   # AppShell, Sidebar, Topbar, CompanySelector, UserMenu, NotificationCenter, CommandPalette
    navigation.ts            # sidebar groups, items, icons, nested children, routes
    providers.tsx            # QueryClient, Toast, Tooltip providers
    router.tsx               # TanStack Router setup
  routes/                    # file-based routes: __root.tsx, index.tsx, dashboard.tsx, fleet/trucks.tsx …
  features/<module>/         # pages and feature components (Phase 2: dashboard, gallery, example pages)
  demo/                      # realistic demo data + fake API with latency (Phase 2 only; replaced by real APIs from Phase 3)
  lib/                       # api client, formatting (money, miles, dates, relative time), hooks
```

---

## 10. Phase 2 acceptance

- Gallery at `/dev/gallery` shows every component in every state on one scrollable page with a section index.
- Shell renders every sidebar route with a real page header and either a working example page or a designed "Coming in Phase N" empty state.
- Dashboard shell laid out per §5 with demo data; example truck table with drawer; example load detail page; example truck form; example AI command center layout.
- Loading, empty, and error states demonstrated on the table, KPI cards, and a card.
- No console errors or warnings during navigation; lint, typecheck, and tests pass; responsive at 1280 / 1024 / 768; keyboard paths verified.
