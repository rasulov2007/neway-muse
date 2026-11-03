# NeWay Porcelain: design spec for the build

**Version:** Sep 16, 2026  
**Status:** Approved look: Porcelain light and Porcelain dark  
**Scope:** The look (colors, typography, sizes, component states) and a per-user Appearance setting

---

## 1. What this covers

- The Porcelain look in **light and dark**, applied to the **existing** NeWay screens and components.
- An **Appearance** setting (**Light / Dark / System**) that each worker chooses. It follows them to any computer.
- **Style only what already exists.** Section 7 describes more parts than the app may have today. If a part doesn't exist (for example number cards, a time-zone clock or row checkboxes), don't build it. List it in your report.
- **Not covered:** everything in section 12 ("Later"): layout and workflow changes, data formatting, copy edits and new business rules.
- **Reference pictures:** they show a proposed future layout. Copy their look (colors, type, sizes, states), not their structure.

## 2. Principles

1. Calm, dense and readable for long shifts. There is one accent color (turquoise), everything else is neutral, and status colors appear only for status.
2. **Status is never shown by color alone.** Every status has a symbol and a word.
3. Light and dark differ **only in color**. Type, sizes, spacing, icons and status shapes stay identical.
4. No gradients, no oversized elements, and no pure black surfaces or pure white text in dark mode.
5. Every color comes from a token in `porcelain-theme.css`. Components never contain hex values.

## 3. Files in this folder

| File | What it is |
|---|---|
| `SPEC.md` | This document |
| `porcelain-theme.css` | Color tokens for light and dark (plus the system and print fallbacks), size and radius variables, and type classes. Ready to import. |
| `porcelain-tokens.json` | The same values as data, for Tailwind or other theme configs |
| `appearance.js` | Reference script for Light / Dark / System: no flash on load, saved per user |
| `icons/status-*.svg` | The seven status symbols. Use them inline so theme colors apply. |
| `screens/*.png` | Reference pictures in light and dark |

## 4. Color tokens

Contrast uses the WCAG 2.x formula. Text needs at least 4.5:1; icons, symbols and chart marks need at least 3:1.

| Token | Light | Dark | Use | Contrast (light / dark) |
|---|---|---|---|---|
| **Surfaces** | | | | |
| `--nw-bg` | `#F3F5F4` | `#121615` | App canvas behind cards and panels |  |
| `--nw-sidebar` | `#FAFBFA` | `#0F1312` | Sidebar and collapsed menu |  |
| `--nw-panel` | `#FFFFFF` | `#181D1C` | Cards, panels, top bar, table rows |  |
| `--nw-subtle` | `#F6F8F7` | `#1C2221` | Table header, totals row, auto-filled fields, list section headers, notes |  |
| `--nw-raised` | `#FFFFFF` | `#1F2625` | Menus, dropdowns, popovers, dialogs, side panels |  |
| `--nw-field` | `#FFFFFF` | `#141918` | Input and checkbox fill |  |
| `--nw-segment` | `#E9EDEB` | `#28302E` | Segmented control track (dark value changed from the mockups so it shows inside menus) |  |
| **Lines** | | | | |
| `--nw-border` | `#E2E7E5` | `#2A3230` | Panel borders, table lines, dividers, sidebar edge |  |
| `--nw-border-strong` | `#CCD5D2` | `#3A4441` | Inputs, secondary buttons, checkboxes, menu borders, page-tab underline |  |
| **Text** | | | | |
| `--nw-text` | `#16201F` | `#E3E9E7` | Primary text and numbers | 16.66:1 on panel / 13.87:1 on panel |
| `--nw-text-2` | `#4B5856` | `#AAB6B3` | Secondary text, nav items, column headers, field labels | 7.42:1 on panel / 8.16:1 on panel |
| `--nw-text-3` | `#66736F` | `#8D9996` | Muted text: meta lines, hints, placeholders, captions, line icons | 4.94:1 on panel · 4.52:1 on bg / 5.79:1 on panel · 6.19:1 on bg |
| **Accent** | | | | |
| `--nw-accent` | `#0B7A74` | `#45BDB3` | Primary buttons, focus ring, active tab line, selected icons, checked boxes, chart highlight | 5.18:1 on panel / 7.46:1 on panel |
| `--nw-accent-hover` | `#096660` | `#5CCAC0` | Primary button hover |  |
| `--nw-on-accent` | `#FFFFFF` | `#062321` | Text and icons on an accent fill | 5.18:1 on accent / 7.23:1 on accent |
| `--nw-accent-tint` | `#E0F1EF` | `#17302D` | Selected nav item, active chip, focus halo, avatar, time-zone tag |  |
| `--nw-accent-ink` | `#075C57` | `#7FD6CD` | Text on accent-tint, links, active tab text, selected nav text | 7.84:1 on panel · 6.72:1 on accent-tint / 10.07:1 on panel · 8.28:1 on accent-tint |
| **States** | | | | |
| `--nw-hover` | `#F3F7F6` | `#1D2423` | Row and item hover |  |
| `--nw-selected` | `#EDF7F5` | `#1A2E2B` | Selected table row (always paired with a checked checkbox) |  |
| `--nw-highlight` | `#EDF7F5` | `#253230` | Highlighted item in menus, dropdowns and lists (pointer or keyboard); ghost-button hover on raised surfaces |  |
| **Status: urgent** | | | | |
| `--nw-urgent-text` | `#B42318` | `#F2A097` | Word and numbers | 5.79:1 on urgent-bg / 7.96:1 on urgent-bg |
| `--nw-urgent-bg` | `#FDEDEB` | `#2C1C1A` | Pill and banner fill |  |
| `--nw-urgent-border` | `#F5C8C2` | `#4E2B27` | Pill outline |  |
| `--nw-urgent-icon` | `#C8321F` | `#E86B5E` | Octagon symbol | 4.70:1 on urgent-bg / 5.20:1 on urgent-bg |
| **Status: warning** | | | | |
| `--nw-warning-text` | `#8A4B00` | `#E8C57C` | Word and numbers | 6.23:1 on warning-bg / 9.42:1 on warning-bg |
| `--nw-warning-bg` | `#FFF4DE` | `#29231A` | Pill and banner fill |  |
| `--nw-warning-border` | `#F2D7A0` | `#4D4020` | Pill outline; required-field outline |  |
| `--nw-warning-icon` | `#B86E00` | `#D8A443` | Diamond symbol | 3.65:1 on warning-bg / 6.90:1 on warning-bg |
| **Status: done** | | | | |
| `--nw-done-text` | `#1D6A36` | `#92D2A8` | Word and numbers; good change | 5.89:1 on done-bg / 9.02:1 on done-bg |
| `--nw-done-bg` | `#E7F5EC` | `#16261F` | Pill fill |  |
| `--nw-done-border` | `#BCDFC8` | `#28453A` | Pill outline |  |
| `--nw-done-icon` | `#238044` | `#4DB77A` | Check-circle symbol | 4.40:1 on done-bg / 6.29:1 on done-bg |
| **Status: in motion** | | | | |
| `--nw-moving-text` | `#1F4E8F` | `#A2C0F0` | Word | 7.20:1 on moving-bg / 8.63:1 on moving-bg |
| `--nw-moving-bg` | `#E9F0FB` | `#172233` | Pill fill |  |
| `--nw-moving-border` | `#C7D7F0` | `#2A3D5E` | Pill outline |  |
| `--nw-moving-icon` | `#2C64B5` | `#6B9BE6` | Arrow-circle symbol | 5.09:1 on moving-bg / 5.68:1 on moving-bg |
| **Status: neutral** | | | | |
| `--nw-neutral-text` | `#4B5856` | `#AAB6B3` | Word | 6.58:1 on neutral-bg / 7.45:1 on neutral-bg |
| `--nw-neutral-bg` | `#EEF2F1` | `#1F2524` | Pill fill |  |
| `--nw-neutral-border` | `#D9E0DE` | `#323B39` | Pill outline |  |
| `--nw-neutral-icon` | `#6F7C79` | `#8D9996` | Ring, info and wrench symbols | 3.85:1 on neutral-bg / 5.29:1 on neutral-bg |
| **Status: all** | | | | |
| `--nw-status-glyph` | `#FFFFFF` | `#0F1312` | Mark inside the solid status symbols (!, check, arrow) |  |
| **Charts** | | | | |
| `--nw-chart-1` | `#12938A` | `#2FA59C` | Gross / revenue series | 3.77:1 on panel / 5.67:1 on panel |
| `--nw-chart-2` | `#8A63CF` | `#8E78DA` | Cost series | 4.41:1 on panel / 4.75:1 on panel |
| `--nw-chart-grid` | `#EAEFED` | `#252C2B` | Grid lines |  |
| `--nw-chart-band` | `#F1F6F5` | `#1C2322` | Highlighted current period |  |
| `--nw-track` | `#DCE5E2` | `#2A3230` | Progress and utilization bar track |  |
| **Added for the build** | | | | |
| `--nw-danger` | `#B42318` | `#E86B5E` | Destructive button fill (not shown in the mockups) |  |
| `--nw-danger-hover` | `#951D14` | `#F2A097` | Destructive button hover |  |
| `--nw-on-danger` | `#FFFFFF` | `#121615` | Text on destructive button | 6.57:1 on danger / 5.82:1 on danger |
| `--nw-tooltip-bg` | `#16201F` | `#E3E9E7` | Tooltip fill (inverted) |  |
| `--nw-tooltip-text` | `#FFFFFF` | `#181D1C` | Tooltip text | 16.66:1 on tooltip-bg / 13.87:1 on tooltip-bg |
| `--nw-backdrop` | `rgba(22, 32, 31, 0.40)` | `rgba(0, 0, 0, 0.60)` | Dialog backdrop |  |
| `--nw-paper` | `#FFFFFF` | `#FFFFFF` | Document and PDF previews, printouts (white in both modes) |  |
| `--nw-paper-text` | `#16201F` | `#16201F` | Text on paper (same in both modes) | 16.66:1 on paper / 16.66:1 on paper |
| `--nw-input-border-strict` | `#89918E` | `#67706D` | Optional: input borders at 3:1 on panels and fields, for strict WCAG 1.4.11 | 3.23:1 on panel · 3.23:1 on field / 3.34:1 on panel · 3.48:1 on field |
| **Elevation** | | | | |
| `--nw-shadow-menu` | `0 1px 2px rgba(22, 32, 31, 0.05), 0 6px 20px rgba(22, 32, 31, 0.07)` | `0 1px 2px rgba(0, 0, 0, 0.40), 0 8px 24px rgba(0, 0, 0, 0.28)` | Menus, popovers, dialogs, side panels (the only shadows) |  |
| `--nw-shadow-card` | `0 1px 2px rgba(0, 0, 0, 0.03)` | `none` | Dashboard number cards only; other cards use a border |  |
| `--nw-shadow-segment` | `0 1px 2px rgba(0, 0, 0, 0.08)` | `0 1px 2px rgba(0, 0, 0, 0.30)` | Active item in a segmented control |  |

- **Sidebar:** `--nw-sidebar` (`#FAFBFA` in light) stays slightly lighter than the canvas. Darker sidebar tints were reviewed and not chosen.
- **Two dark values differ from the approved mockups:**
  - `--nw-segment` is `#28302E`, so segmented controls stay visible inside menus as well as on pages.
  - `--nw-highlight` (`#253230`) was added so highlighted menu items are visible on dark menus.
- **Tokens under "Added for the build"** aren't in the mockups, but the app needs them: destructive buttons, tooltips, the dialog backdrop, paper, and an optional stricter input border.
- **Theme scopes:** the light and dark blocks match `data-theme` (and `.dark` / `.light`) on **any** element, not only `<html>`. A wrapper with `data-theme="light"` keeps a document preview light inside a dark page. Never put `.dark` and `data-theme="light"` on the same element.
- **Printing** always uses the light values.

## 5. Typography

- **Font:** Manrope.
  - Self-host it with `@fontsource/manrope`, or use Google Fonts.
  - Load the latin, latin-ext and cyrillic subsets.
  - Weights 400–700, plus 800 for the tiny count bubble on the collapsed menu.
  - Fallback: `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- **Base:** 13px, weight 500, line height 1.4, color `--nw-text`.
- **Type classes:** `porcelain-theme.css` has a `.nw-type-*` class for each style below. Each class sets every property. If you use the CSS `font` shorthand instead, set `letter-spacing`, `text-transform` and `font-variant-numeric` **after** it, because the shorthand resets them.

| Style | Size / weight / line height | Letter spacing | Use |
|---|---|---|---|
| `page-title` | 22px / 700 / 1.2 | -0.015em | Page titles |
| `kpi` | 28px / 700 / 1.15 | -0.02em | Big numbers on dashboard cards |
| `section-title` | 15px / 700 / 1.3 | -0.005em | Headings above a group of panels |
| `panel-title` | 14px / 700 / 1.3 | 0 | Card, panel and dialog titles |
| `body` | 13px / 500 / 1.4 | 0 | Default UI text and table cells (use 400 for long paragraphs) |
| `field` | 13.5px / 500 / 1.4 | 0 | Values inside inputs and selects |
| `page-tab` | 13.5px / 600 / 1.3 | 0 | Page-level tabs |
| `tab` | 13px / 600 / 1.3 | 0 | Tabs inside panels |
| `button` | 13px / 600 / 1 | 0 | Buttons |
| `button-sm` | 12.5px / 600 / 1 | 0 | Small buttons, segmented control items |
| `column-header` | 12px / 600 / 1.3 | 0 | Table column headers, field labels |
| `status` | 12px / 600 / 1 | 0 | Status pills and filter chips |
| `meta` | 12.5px / 500 / 1.4 | 0 | Secondary lines, page subtitles (12px for card footers and tooltips) |
| `cell-second-line` | 11.5px / 500 / 1.35 | 0 | Second line inside table cells, field hints |
| `counter` | 11px / 700 / 1 | 0 | Counts in nav items and tabs (800 in the tiny bubble on the collapsed menu) |
| `caps-label` | 11px / 700 / 1.3 | 0.07em · uppercase | Sidebar group names, list section headers |

- **Numbers:** use tabular figures (`font-variant-numeric: tabular-nums`) in tables, number cards, times and money, and right-align number columns. **Don't** change how numbers are formatted in this task (see section 12).

## 6. Sizes and spacing

- **What may change:** component sizes (heights, paddings, radii, font sizes).
- **What may not change:** page structure, the set and order of columns, and where things sit on the page.
- **If a size would hide content** (for example a table that would start scrolling sideways), keep the current size and report it.
- **Spacing** is mostly on a 4 px grid. Component sizes are exactly as listed.

| Variable | Value | Use |
|---|---|---|
| `--nw-sidebar-width` | 232px | Sidebar |
| `--nw-rail-width` | 64px | Collapsed menu |
| `--nw-topbar-height` | 56px | Top bar and sidebar logo row |
| `--nw-page-padding` | 20px 24px 24px | Page content padding |
| `--nw-gap` | 16px | Between page blocks |
| `--nw-gap-group` | 10px | Heading to content inside a group |
| `--nw-panel-padding` | 16px | Panel body |
| `--nw-panel-header-height` | 48px | Panel header minimum height (padding 12px 16px) |
| `--nw-kpi-card-padding` | 16px 18px 14px | Dashboard number card |
| `--nw-header-row-height` | 34px | Table header row |
| `--nw-row-height` | 40px | Table row, one line |
| `--nw-row-height-2line` | 54px | Table row, two lines |
| `--nw-cell-padding-x` | 10px | Table cell side padding |
| `--nw-control-height` | 32px | Buttons, date-range button, nav items |
| `--nw-control-height-sm` | 28px | Small buttons |
| `--nw-input-height` | 36px | Inputs and selects |
| `--nw-search-height` | 34px | Top bar search |
| `--nw-chip-height` | 24px | Filter chips |
| `--nw-pill-height` | 22px | Status pills |
| `--nw-counter-height` | 20px | Counts in nav items |
| `--nw-checkbox-size` | 16px | Checkboxes |
| `--nw-icon-size` | 16px | Line icons (14px dense, 18px in the collapsed menu) |
| `--nw-avatar-size` | 30px | Avatars (28px in lists) |

| Radius variable | Value | Use |
|---|---|---|
| `--nw-radius-panel` | 10px | Panels, menus, popovers, dialogs, dropdown lists |
| `--nw-radius-kpi` | 12px | Dashboard number cards |
| `--nw-radius-segment` | 9px | Segmented control track, collapsed-menu items |
| `--nw-radius-control` | 8px | Buttons, inputs, nav items, search |
| `--nw-radius-control-sm` | 7px | Small buttons |
| `--nw-radius-pill` | 6px | Status pills, counters, segmented items, tooltips |
| `--nw-radius-chip` | 12px | Filter chips |
| `--nw-radius-checkbox` | 4px | Checkboxes |

**Shadows** appear only in these places:
- `--nw-shadow-menu`: menus, popovers, dialogs and side panels
- `--nw-shadow-segment`: the active item in a segmented control
- `--nw-shadow-card`: a faint shadow on dashboard number cards

Other cards use a border.

## 7. Components (style them wherever they already exist)

### App frame
- **Sidebar**
  - `--nw-sidebar` fill with a 1 px `--nw-border` right edge.
  - The logo row is `--nw-topbar-height` (56 px) tall, so its bottom border lines up with the top bar's bottom border.
  - Group names use `.nw-type-caps-label` in `--nw-text-3`.
- **Nav item**
  - 32 px tall, radius 8, padding 0 × 10 px, 9 px gap.
  - Text 13/500 in `--nw-text-2`; 16 px icon in `--nw-text-3`.
  - **Hover:** `--nw-hover`.
  - **Selected:** `--nw-accent-tint` fill, `--nw-accent-ink` text at 700, icon in `--nw-accent`.
- **Counters in nav items** (20 px, radius 6, `.nw-type-counter`)
  - Plain counts use `--nw-accent-tint` with `--nw-accent-ink`.
  - Urgent and warning counts use that status's pill colors plus its symbol.
- **Collapsed menu:** 64 px wide.
  - Items are 40 × 40 with radius 9; selected items get a tint fill and an accent icon.
  - The count bubble uses `--nw-urgent-icon` with `--nw-status-glyph` text.
- **Top bar:** 56 px tall, `--nw-panel` fill, 1 px bottom border, 20 px side padding.
  - **Search:** 34 px, radius 8, `--nw-bg` fill, placeholder in `--nw-text-3`. A shortcut hint, if shown, is a small key with a 1 px `--nw-border-strong` border.
  - **Notification count:** an `--nw-urgent-icon` bubble.
  - **User:** 30 px avatar (tint and ink), name 13/700, role 12 px in `--nw-text-3`.

### Page header
- **Title:** `.nw-type-page-title`.
- **Subtitle:** `.nw-type-meta` in `--nw-text-3`.
- **Controls on the right** (filters, date range, buttons): use the button, segmented control and input styles below.

### Cards and panels
- **Panel**
  - `--nw-panel` fill, 1 px `--nw-border`, radius 10, no shadow.
  - **Header:** at least 48 px tall with 12 × 16 px padding. It holds a `.nw-type-panel-title`, an optional 12 px note in `--nw-text-3`, and an optional right-aligned link (`--nw-accent-ink`, 600, with a chevron).
  - **Footer:** 12 px `--nw-text-3` above a top border.
- **Big numbers** (if the dashboard already shows them)
  - Value: `.nw-type-kpi`.
  - Label: 13/600 `--nw-text-2`.
  - Change: an arrow and amount in `--nw-done-text` if good or `--nw-urgent-text` if bad.
  - Number cards (radius 12, `--nw-shadow-card`) are the target look. Turning today's metric strip into four separate cards is in section 12.
- **Note strip inside a panel:** 12 px `--nw-text-2` with the info symbol and a bottom border.

### Buttons
| Type | Look |
|---|---|
| Primary | `--nw-accent` fill, `--nw-on-accent` text, `.nw-type-button`, 32 px, radius 8, padding 0 × 12 px. Hover `--nw-accent-hover`. Disabled at 45% opacity. |
| Secondary (outline) | `--nw-panel` fill, 1 px inset `--nw-border-strong`, `--nw-text` |
| Ghost | No fill, `--nw-text-2`. Hover `--nw-hover` on panels or `--nw-highlight` on menus and dialogs. |
| Destructive | `--nw-danger` fill, `--nw-on-danger` text. Hover `--nw-danger-hover`. |
| Small | 28 px, radius 7, `.nw-type-button-sm` |

Focus on any button or link: a 2 px `--nw-accent` outline with a 2 px offset.

### Inputs and forms
- **Input and select**
  - 36 px, radius 8, `--nw-field` fill, 1 px inset `--nw-border-strong`, padding 0 × 10 px.
  - Text: `.nw-type-field`. Leading icons are 15 px in `--nw-text-3`.
- **Label:** 12/600 `--nw-text-2` above the field.
  - The required mark `*` is `--nw-urgent-text`.
  - The hint below is 11.5 px `--nw-text-3`.
- **Placeholder:** `--nw-text-3`. Don't rewrite placeholder text in this task.
- **States**

  | State | Look |
  |---|---|
  | Focus | 1.5 px inset `--nw-accent` plus a 3 px `--nw-accent-tint` halo |
  | Read-only, or filled in by the system | `--nw-subtle` fill, `--nw-text-2` text |
  | Required and empty (when the form shows validation) | 1 px `--nw-warning-border` outline; message in `--nw-warning-text` with the diamond symbol |
  | Error | 1 px `--nw-urgent-icon` outline; message in `--nw-urgent-text` with the octagon symbol |

- **Checkbox:** 16 px, radius 4, 1.5 px inset `--nw-border-strong`. Checked: `--nw-accent` fill with an `--nw-on-accent` check.
- **Switch:** `--nw-accent` when on, `--nw-border-strong` when off.
- **Dropdown list**
  - `--nw-raised` fill, 1 px `--nw-border-strong`, radius 10, `--nw-shadow-menu`.
  - Section headers (if any) use `.nw-type-caps-label` on `--nw-subtle`.
  - Rows have 8 × 12 px padding and are divided by 1 px `--nw-border` lines.
  - The highlighted row (pointer or keyboard) is `--nw-highlight`.
  - Disabled rows: dim the name and avatar to 62% opacity, but keep any explanation text at full `--nw-text-2`.

### Tabs, segmented controls, chips
- **Page tabs:** `.nw-type-page-tab` in `--nw-text-2`.
  - Active: `--nw-accent-ink` text with a 2 px `--nw-accent` underline.
  - Counts sit in small rounded badges: `--nw-subtle` with a border, or tint and ink when active.
  - The tab row has a 1 px `--nw-border-strong` bottom line.
- **Panel tabs:** `.nw-type-tab` with 20 px gaps and the same active style.
- **Segmented control:** track `--nw-segment`, radius 9, padding 3.
  - Items are 26 px, radius 6, `.nw-type-button-sm`, `--nw-text-2`.
  - Active: `--nw-panel` fill, `--nw-accent-ink` text, `--nw-shadow-segment` and a 1 px `--nw-border` ring. The active item is lighter than the track in light mode and darker in dark mode.
- **Filter chips:** 24 px, radius 12, `.nw-type-status`, `--nw-text-2` on `--nw-subtle` with a 1 px `--nw-border`.
  - Active: tint fill with `--nw-accent-ink` text.

### Status
Every status uses a **symbol plus a word**. There are two forms:

- **Pill:** 22 px, radius 6, `.nw-type-status`, padding 0 8 0 6 px.
  - Fill `--nw-<family>-bg`, text `--nw-<family>-text`, 1 px inset outline `--nw-<family>-border`.
  - 13 px symbol.
- **Text form:** for dense lists and table cells. A 14 px symbol plus the word in `--nw-<family>-text`, with no fill.

There are five token families (`<family>`): `urgent`, `warning`, `done`, `moving` and `neutral`.

| Status | Token family | Symbol (`icons/`) | Examples in NeWay |
|---|---|---|---|
| Urgent | `urgent` | Filled octagon with "!" (`status-urgent.svg`) | Missed appointment, on hold, expired, out of service |
| Warning | `warning` | Filled diamond with "!" (`status-warning.svg`) | Delayed, expiring within 30 days, idle, open accident |
| Done | `done` | Filled circle with check (`status-done.svg`) | Available, delivered, ready to bill, paid |
| In motion | `moving` | Filled circle with arrow (`status-moving.svg`) | In transit, at delivery, loading, loaded, dispatched |
| Neutral | `neutral` | Ring with dash (`status-neutral.svg`) | Booked, assigned, draft, inactive |
| In shop | `neutral` | Wrench line icon (`status-in-shop.svg`) | In shop |
| Info | `neutral` (pill uses the neutral fill and text) | Filled circle with "i" (`status-info.svg`) | Notes, "waiting for review" |

- **Statuses not in this table:** don't choose a family yourself. List them with where they appear, and ask.
- **Changes:** show an arrow and the amount. Good changes use `--nw-done-text` and bad changes use `--nw-urgent-text`, so direction shows in the arrow as well as the color.

### Tables
- **Header:** 34 px, `--nw-subtle` fill, `.nw-type-column-header` in `--nw-text-2`, 1 px bottom border.
- **Rows:** 40 px (54 px when a cell has two lines), `--nw-panel` fill, 1 px `--nw-border` lines, cell padding 0 × 10 px.
- **Hover:** `--nw-hover`.
- **Selected** (tables that already support selection): `--nw-selected`, and keep the checked checkbox visible. The two fills are nearly the same in light mode.
- **Columns:** ID columns are bold. Number columns are right-aligned with tabular figures. Sticky columns (where they already exist) need an opaque `--nw-panel` background.
- **Second line in a cell:** `.nw-type-cell-second-line` in `--nw-text-3`.
- **Totals row:** `--nw-subtle` fill, weight 700.

### Menus, dialogs, side panels, tooltips, toasts
- **Menus, dropdowns, popovers, dialogs and side panels:** `--nw-raised` fill, 1 px `--nw-border-strong`, radius 10, `--nw-shadow-menu`. Highlighted items use `--nw-highlight`.
- **Dialog backdrop:** `--nw-backdrop`.
- **Maps and other embedded content** must sit *below* dialogs and menus. Today the map covers dialog buttons.
- **Tooltip:** `--nw-tooltip-bg` fill, `--nw-tooltip-text`, 12 px, radius 6.
- **Toast:** a raised surface with the status symbol and a word.

### Charts, maps and documents
- **Series colors:** gross or revenue `--nw-chart-1`, cost `--nw-chart-2`. If a chart needs more than two series, ask.
- **Chart parts:** grid lines in `--nw-chart-grid`, the current period in `--nw-chart-band`, axis text 11 px `--nw-text-3`, square legend keys.
- **Progress bars:** 8 px, radius 4, track `--nw-track`, fill `--nw-chart-1`. Keep the value shown as text.
- **Maps:** light tiles in light mode and dark tiles in dark mode, using the map provider's dark style. Map markers: list them in your report; don't redesign them in this task.
- **Documents:** PDF and image previews (rate confirmations, BOL, POD, invoices) **stay white in both modes**.
  - Put `class="nw-paper"` on the preview area, or wrap it in `data-theme="light"`.
  - Printouts are light automatically (the print block in the CSS).

### Icons and logo
- **Line icons:** 16 px, 1.6 px stroke, round caps and joins, Lucide style. Use 14 px in dense spots and 18 px in the collapsed menu. Default color `--nw-text-3`.
- **Status symbols:** from `icons/`. 13 px in pills; 14 px in text form and lists.
- **Logo:** a 28 px `--nw-accent` square (radius 8) with the NeWay mark in `--nw-on-accent`. Name 17/700; company name 11 px `--nw-text-3`.

## 8. Dark mode rules

- **Surfaces:** no pure black. They step up in lightness as they get closer to the user:
  1. Sidebar `#0F1312`
  2. Canvas `#121615`
  3. Panels `#181D1C`
  4. Menus and dialogs `#1F2625`
- **Text:** `#E3E9E7`, not pure white.
- **Borders stay subtle:** `#2A3230` on panels and `#3A4441` on inputs.
- **Shadows:** only on menus, dialogs, side panels and the active segment. Number cards have no shadow.
- **Accent:** lighter turquoise `#45BDB3` with **dark** text (`#062321`) on buttons, not a glowing brand color.
- **Status colors** are softer. Each status keeps its symbol and word.
- **Charts** use their own validated dark pair (`#2FA59C` and `#8E78DA`).
- **Maps** use dark tiles. **Documents and printouts stay light.**
- **No shortcuts:** don't invert colors, and don't put CSS filters on the page.
- **Third-party widgets** (date pickers, maps, charts, toasts, rich tables) must use the tokens too. List any that can't.

## 9. Appearance setting (Light / Dark / System)

- **Where:** the account menu (avatar, top right), under "Appearance", as a segmented control with sun, moon and monitor icons: **Light · Dark · System**. If the app already has a profile or settings page, add the same control there.
- **Helper text:**
  - When System is selected: "Follows your computer's setting."
  - Otherwise: "Saved to your account on every device."
- **Default:** System.
- **Saved on the user's profile (server)**
  - Add one field, `appearance`: `light | dark | system`, default `system`, with a migration.
  - Include the field in the signed-in user data the app already loads.
  - Save it with one small endpoint, for example `PATCH /api/me/preferences { "appearance": "dark" }`. The user can change only their own value.
- **Browser side:** inline `appearance.js` in `<head>`. Its header comment explains the setup (React/Next hydration, CSP nonce, removing other theme switchers).
  - **Every time the signed-in user's profile loads** (app start, sign-in, profile refresh): `const toSave = NewayAppearance.sync(user.id, user.appearance)`. If it returns a value, save that value to the profile. It means an earlier choice never reached the server.
  - **When the worker picks an option:** `NewayAppearance.set(value, user.id)`, then save it. When the server confirms, call `NewayAppearance.markSaved(user.id)`.
  - **If saving fails:** keep the choice on screen, show "Couldn't save your appearance setting. We'll try again." and retry on the next profile load (`sync` returns the value).
  - **Normally the profile value wins.** A choice that hasn't been saved yet is kept until it is.
- **Behavior**
  - Changes apply immediately, without a reload, in every open tab.
  - System follows the operating system's setting live, including when it switches at night.
  - **Before sign-in** (login page), the page uses the last signed-in user's choice on that computer, otherwise System. On a shared computer the next worker may see that theme for a moment until their own applies. Rendering `data-theme` on the server from the profile avoids that.
- **Only colors change** between modes. Nothing moves or resizes.

## 10. Accessibility (measured)

- **Text passes AA in both modes.**
  - Light, worst case: `--nw-text-3` on the canvas is 4.52:1.
  - Dark, worst case: `--nw-text-3` on a selected row is 4.85:1, and on `--nw-highlight` it's 4.52:1.
  - Status words on their pill fills: 5.79–7.20:1 in light and 7.45–9.42:1 in dark.
- **Focus is always visible** (accent ring) in both modes.
- **Known trade-offs.** Keep these unless you want stricter compliance:
  - **Input borders** are soft: `--nw-border-strong` is 1.50:1 on white and 1.69:1 on dark panels. WCAG 1.4.11 asks for 3:1 when the border is the only thing marking a field.
    - For strict compliance, use `--nw-input-border-strict` for input borders only. It reaches 3:1 on panels and fields; in light mode it's 2.95:1 on the bare canvas.
  - **Required-field outline** (`--nw-warning-border`) is 1.40:1 on white. The message and diamond symbol carry the meaning, so always show them.
  - **Hover and selected rows** look almost the same in light mode. On selected rows, keep the checked checkbox visible.
  - **Progress bar fill** against its track is 2.94:1 in light mode. Keep the value printed as text.

## 11. Reference pictures (`screens/`)

| File | Shows |
|---|---|
| `01-components-light.png` / `02-components-dark.png` | Component sheet: type scale, colors, buttons, inputs, tabs, chips, statuses, sidebar states, dropdown, table rows, number card, chart, toast |
| `03-dashboard-light.png` / `04-dashboard-dark.png` | Dashboard at 1440 px wide |
| `05-loads-light.png` / `06-loads-dark.png` | Loads list with a detail panel |
| `07-new-load-light.png` / `08-new-load-dark.png` | New load form with the driver list open |
| `09-appearance-menu.png` | The Appearance setting in the account menu, light and dark |

The page pictures (03–08) use demo data and a **proposed** layout. They include things listed in section 12, such as the "Needs action" list, the four number cards, the Loads side panel, the new form order, and driver-list groups based on dispatch eligibility. Use them only for colors, type, sizes and states.

## 12. Later (not in this task)

These ideas come from the redesign review. Some need decisions or backend rules first.

- **Dashboard**
  - "Needs action" list with owners.
  - Today's metric strip split into four separate number cards, each with its basis line.
  - Regrouped sections.
  - Time-zone clocks.
- **Loads**
  - Active loads as the default view, and a date filter.
  - A "next step" column, and a side panel with next steps and documents.
  - Two-line rows where the table doesn't have them yet.
  - Frozen ID column where the table doesn't have one yet.
- **New load and other forms:** new field order and steps, auto-fill, and duplicate checks.
- **Dispatch eligibility:** grouping, blocking or overriding drivers and trucks that can't be dispatched.
- **Row selection:** adding checkboxes to tables that don't have them.
- **Number formatting:** minus sign (−), compact money ($20.1K), and period/basis labels next to numbers.
- **Empty values:** "Not set", "Not tracked", "No data yet", "Stale · 9 d" instead of blanks or zeros.
- **Copy edits:** sentence case everywhere, and new placeholder texts.
- **Status mapping:** for statuses not listed in section 7.
- **Map markers:** redesign with symbols.

## 13. Don't

- Don't restructure pages, add or remove features, or change workflows, data, calculations, number formatting, routes or permissions. The only exception is the `appearance` field and its endpoint in section 9.
- Don't add colors outside `porcelain-theme.css`. If something needs a color that has no token, ask.
- Don't use color alone for any status.
- Don't invert colors automatically for dark mode, or apply CSS filters to the page.
- Don't darken documents, PDFs or printouts.
- Don't create, edit or delete records to take screenshots.

---

## Appendix A: if the app uses shadcn/ui (Tailwind + Radix)

The live app uses Radix dropdowns and dialogs, which suggests shadcn/ui. Check before relying on this appendix.

**Where to put the mapping:** in a rule on `:root, [data-theme], .dark, .light`, not only `:root`, so scoped wrappers (document previews) get their own values.

**Mapping**

| shadcn variable | Porcelain token |
|---|---|
| `--background` / `--foreground` | `--nw-panel` / `--nw-text`. Then give the page body and app shell `--nw-bg` explicitly; shadcn's outline buttons and inputs use `bg-background` and must stay white in light mode. |
| `--card` / `--card-foreground` | `--nw-panel` / `--nw-text` |
| `--popover` / `--popover-foreground` | `--nw-raised` / `--nw-text` |
| `--primary` / `--primary-foreground` | `--nw-accent` / `--nw-on-accent` |
| `--secondary` / `--secondary-foreground` | `--nw-subtle` / `--nw-text` |
| `--muted` / `--muted-foreground` | `--nw-subtle` / `--nw-text-3` |
| `--accent` / `--accent-foreground` | `--nw-highlight` / `--nw-text`. shadcn uses these for highlighted menu items and ghost-button hover. They are **not** our turquoise accent. |
| `--destructive` | `--nw-danger` (text on it: `--nw-on-danger`) |
| `--border` / `--input` / `--ring` | `--nw-border` / `--nw-border-strong` / `--nw-accent` |
| `--chart-1` / `--chart-2` | `--nw-chart-1` / `--nw-chart-2`. Ask before assigning more series. |
| `--sidebar` / `--sidebar-foreground` / `--sidebar-border` / `--sidebar-ring` | `--nw-sidebar` / `--nw-text-2` / `--nw-border` / `--nw-accent` |
| `--sidebar-primary` / `--sidebar-primary-foreground` | `--nw-accent` / `--nw-on-accent` |
| `--sidebar-accent` / `--sidebar-accent-foreground` | `--nw-hover` / `--nw-text` |
| `--radius` | `0.625rem` (10 px). shadcn derives `rounded-md` = 8 px (buttons, inputs) and `rounded-lg` = 10 px (menus, dialogs). Set Card to 10 px. |

**Component adjustments**
- **Variant names:** our "Secondary" button is shadcn's `outline` variant. shadcn's `secondary` variant uses `--nw-subtle`.
- **Inputs:** give Input, Textarea and SelectTrigger `--nw-field` in both modes. Replace shadcn v4's `dark:bg-input/30`.
- **Active sidebar item:** shadcn uses one color for hover and active items. Give the **active** item `--nw-accent-tint`, `--nw-accent-ink` and an `--nw-accent` icon.
- **Version check:**
  - Tailwind v3 shadcn stores bare HSL numbers (`--background: 0 0% 100%`) and uses `hsl(var(--background))`. There, point the Tailwind colors straight at the `--nw-*` variables (Appendix B) instead of mapping `--background` to a hex value.
  - Tailwind v4 shadcn stores full colors, so the mapping above works as written.

## Appendix B: Tailwind color names (if Tailwind is used)

**Tailwind v3** (`tailwind.config.js`, `darkMode: ['class']`):

```js
// theme.extend.colors
nw: {
  'bg': 'var(--nw-bg)',
  'sidebar': 'var(--nw-sidebar)',
  'panel': 'var(--nw-panel)',
  'subtle': 'var(--nw-subtle)',
  'raised': 'var(--nw-raised)',
  'field': 'var(--nw-field)',
  'segment': 'var(--nw-segment)',
  'border': 'var(--nw-border)',
  'border-strong': 'var(--nw-border-strong)',
  'text': 'var(--nw-text)',
  'text-2': 'var(--nw-text-2)',
  'text-3': 'var(--nw-text-3)',
  'accent': 'var(--nw-accent)',
  'accent-hover': 'var(--nw-accent-hover)',
  'on-accent': 'var(--nw-on-accent)',
  'accent-tint': 'var(--nw-accent-tint)',
  'accent-ink': 'var(--nw-accent-ink)',
  'hover': 'var(--nw-hover)',
  'selected': 'var(--nw-selected)',
  'highlight': 'var(--nw-highlight)',
  'urgent-text': 'var(--nw-urgent-text)',
  'urgent-bg': 'var(--nw-urgent-bg)',
  'urgent-border': 'var(--nw-urgent-border)',
  'urgent-icon': 'var(--nw-urgent-icon)',
  'warning-text': 'var(--nw-warning-text)',
  'warning-bg': 'var(--nw-warning-bg)',
  'warning-border': 'var(--nw-warning-border)',
  'warning-icon': 'var(--nw-warning-icon)',
  'done-text': 'var(--nw-done-text)',
  'done-bg': 'var(--nw-done-bg)',
  'done-border': 'var(--nw-done-border)',
  'done-icon': 'var(--nw-done-icon)',
  'moving-text': 'var(--nw-moving-text)',
  'moving-bg': 'var(--nw-moving-bg)',
  'moving-border': 'var(--nw-moving-border)',
  'moving-icon': 'var(--nw-moving-icon)',
  'neutral-text': 'var(--nw-neutral-text)',
  'neutral-bg': 'var(--nw-neutral-bg)',
  'neutral-border': 'var(--nw-neutral-border)',
  'neutral-icon': 'var(--nw-neutral-icon)',
  'status-glyph': 'var(--nw-status-glyph)',
  'chart-1': 'var(--nw-chart-1)',
  'chart-2': 'var(--nw-chart-2)',
  'chart-grid': 'var(--nw-chart-grid)',
  'chart-band': 'var(--nw-chart-band)',
  'track': 'var(--nw-track)',
  'danger': 'var(--nw-danger)',
  'danger-hover': 'var(--nw-danger-hover)',
  'on-danger': 'var(--nw-on-danger)',
  'tooltip-bg': 'var(--nw-tooltip-bg)',
  'tooltip-text': 'var(--nw-tooltip-text)',
  'backdrop': 'var(--nw-backdrop)',
  'paper': 'var(--nw-paper)',
  'paper-text': 'var(--nw-paper-text)',
},
```

**Tailwind v4** (in your main CSS file):

```css
@custom-variant dark (&:where(.dark, .dark *));
@theme inline {
  --color-nw-bg: var(--nw-bg);
  --color-nw-sidebar: var(--nw-sidebar);
  --color-nw-panel: var(--nw-panel);
  --color-nw-subtle: var(--nw-subtle);
  --color-nw-raised: var(--nw-raised);
  --color-nw-field: var(--nw-field);
  --color-nw-segment: var(--nw-segment);
  --color-nw-border: var(--nw-border);
  --color-nw-border-strong: var(--nw-border-strong);
  --color-nw-text: var(--nw-text);
  --color-nw-text-2: var(--nw-text-2);
  --color-nw-text-3: var(--nw-text-3);
  --color-nw-accent: var(--nw-accent);
  --color-nw-accent-hover: var(--nw-accent-hover);
  --color-nw-on-accent: var(--nw-on-accent);
  --color-nw-accent-tint: var(--nw-accent-tint);
  --color-nw-accent-ink: var(--nw-accent-ink);
  --color-nw-hover: var(--nw-hover);
  --color-nw-selected: var(--nw-selected);
  --color-nw-highlight: var(--nw-highlight);
  --color-nw-urgent-text: var(--nw-urgent-text);
  --color-nw-urgent-bg: var(--nw-urgent-bg);
  --color-nw-urgent-border: var(--nw-urgent-border);
  --color-nw-urgent-icon: var(--nw-urgent-icon);
  --color-nw-warning-text: var(--nw-warning-text);
  --color-nw-warning-bg: var(--nw-warning-bg);
  --color-nw-warning-border: var(--nw-warning-border);
  --color-nw-warning-icon: var(--nw-warning-icon);
  --color-nw-done-text: var(--nw-done-text);
  --color-nw-done-bg: var(--nw-done-bg);
  --color-nw-done-border: var(--nw-done-border);
  --color-nw-done-icon: var(--nw-done-icon);
  --color-nw-moving-text: var(--nw-moving-text);
  --color-nw-moving-bg: var(--nw-moving-bg);
  --color-nw-moving-border: var(--nw-moving-border);
  --color-nw-moving-icon: var(--nw-moving-icon);
  --color-nw-neutral-text: var(--nw-neutral-text);
  --color-nw-neutral-bg: var(--nw-neutral-bg);
  --color-nw-neutral-border: var(--nw-neutral-border);
  --color-nw-neutral-icon: var(--nw-neutral-icon);
  --color-nw-status-glyph: var(--nw-status-glyph);
  --color-nw-chart-1: var(--nw-chart-1);
  --color-nw-chart-2: var(--nw-chart-2);
  --color-nw-chart-grid: var(--nw-chart-grid);
  --color-nw-chart-band: var(--nw-chart-band);
  --color-nw-track: var(--nw-track);
  --color-nw-danger: var(--nw-danger);
  --color-nw-danger-hover: var(--nw-danger-hover);
  --color-nw-on-danger: var(--nw-on-danger);
  --color-nw-tooltip-bg: var(--nw-tooltip-bg);
  --color-nw-tooltip-text: var(--nw-tooltip-text);
  --color-nw-backdrop: var(--nw-backdrop);
  --color-nw-paper: var(--nw-paper);
  --color-nw-paper-text: var(--nw-paper-text);
}
```

`appearance.js` toggles the `dark` class and `data-theme` together, so `dark:` variants and the tokens always agree.
