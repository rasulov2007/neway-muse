Restyle NeWay with our new Porcelain design: a light theme and a matching dark theme with the same typography, plus an Appearance setting (Light / Dark / System) that each worker chooses for themselves.

Everything you need is in `design/porcelain/`. Read `SPEC.md` first. It points to:
- the color tokens (`porcelain-theme.css`, `porcelain-tokens.json`)
- the Appearance script (`appearance.js`)
- the status symbols (`icons/`)
- reference pictures in light and dark (`screens/`)

## What to do
1. **Theme.**
   - Apply Porcelain colors, the Manrope typography, component sizes, radius and component states (SPEC sections 4–8) to the components and pages that **already exist**, in both light and dark.
   - Component sizes may change. Page structure, column sets and the position of elements may not.
2. **Appearance setting.**
   - Add Light / Dark / System to the account menu, with System as the default. If a profile or settings page exists, add the same control there too.
   - Follow SPEC section 9. The choice is saved on each user's profile and applied before the page paints.
   - **Allowed backend change:** one `appearance` field on the user (with a migration), included in the signed-in user data, and one endpoint to save it. No other backend changes.
3. **Status badges.**
   - Wherever the app shows a status, show a symbol, a word and a color, using SPEC section 7.
   - If a status isn't in that table, don't pick a style yourself. List it and ask me.

## Not in this task (SPEC section 12)
- Don't build new parts, even if the pictures or SPEC show them. That includes:
  - the "Needs action" list
  - splitting the dashboard metric strip into four cards
  - clocks
  - the Loads side panel or next-step column
  - the new New load field order
  - dispatch-eligibility groups in pickers
  - new row checkboxes or frozen columns
- Don't change number formatting, empty-value text, wording or placeholder text.
- Don't change data, calculations, business rules, routes or permissions.
- If SPEC describes a part the app doesn't have, skip it and list it in your report.

## How to work
1. **Inspect the codebase first**, then tell me:
   - the framework
   - how styles and colors are defined today (Tailwind version, CSS variables, shadcn/ui, another component library, inline styles)
   - any existing theme or dark-mode code
   - where the sidebar, top bar, tables, status badges, dialogs, charts, maps and document previews live
   - where user settings are stored
   - roughly how many hard-coded colors there are
2. **Give me a step-by-step plan.** Include:
   - how you'll map our tokens onto the existing theme system (see SPEC appendices A and B)
   - how the existing theme code will be replaced, so `appearance.js` is the only thing that sets the theme

   **Don't edit any files until I approve the plan.**
3. **After I approve, work on a new branch in small commits, in this order:**
   1. Tokens, fonts and theme switching
   2. Shared components
   3. Page-by-page pass
   4. The appearance field, endpoint and menu

   Create the branch from the branch that contains `design/porcelain/`.
4. **Colors:**
   - Replace hard-coded colors with the tokens.
   - Don't invent new colors. If something has no token, ask me.
   - Document previews and printouts stay light in dark mode (SPEC section 7, "Charts, maps and documents").
5. **Record the design rules.** Add a short "Design system" section to CLAUDE.md that points to `design/porcelain/SPEC.md`, so future sessions follow it.
6. **Report when you're done:**
   - **Screenshots:** take them in both light and dark using the existing local setup and existing data: Dashboard, Loads, a load's detail page, New load, Trucks, Maintenance, Work orders, Safety and Accounting.
     - Don't create, edit or delete records to take them.
     - If you can't run the app, say so instead.
   - **Lists:** give me
     - anything you couldn't theme (maps, charts, date pickers, other third-party widgets)
     - statuses that need a decision
     - SPEC parts the app doesn't have
     - any contrast problems
   - **Don't merge or deploy.** I'll review first.
