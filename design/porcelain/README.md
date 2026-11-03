# NeWay Porcelain: handoff package for Claude Code

This folder tells Claude Code how to restyle NeWay with the Porcelain design (light and dark, the same typography) and how to add a Light / Dark / System setting that each worker chooses.

## How to use it

1. **Put the folder in the NeWay project.** Unzip the package at the top of the NeWay code folder, so this file ends up at `design/porcelain/README.md`.
   - **Claude Code on your computer:** that's all you need.
   - **Claude Code on the web:** commit the `design/` folder to a new branch on GitHub first, so the cloud session can see it, and tell Claude Code to start from that branch.
2. **Start Claude Code** in the NeWay project.
3. **Paste the contents of `PROMPT.md`** as your message.
4. **Review Claude Code's plan** and approve it (or ask for changes). It won't edit files before you approve.
5. **Review the screenshots and changes** it reports before you merge anything or put it live.

## What's inside

| File | Purpose |
|---|---|
| `PROMPT.md` | The message to paste into Claude Code |
| `SPEC.md` | The full design spec: colors, type, sizes, components, dark mode rules, Appearance setting, accessibility, and what's left for later |
| `porcelain-theme.css` | Ready-to-use color variables for light and dark, with type classes and size variables |
| `porcelain-tokens.json` | The same values as data |
| `appearance.js` | Reference script for Light / Dark / System: saved per user, no white flash on load |
| `icons/` | The seven status symbols (urgent, warning, done, in motion, neutral, info, in shop) |
| `screens/` | Reference pictures in light and dark |

## Good to know

- **Scope.** This package covers the look and the Appearance setting. The setting needs one small backend change: a field on the user profile and an endpoint to save it.
- **Later.** The layout and workflow ideas from the redesign board are a separate job, listed in SPEC section 12. They include "Needs action", four money cards, the Loads side panel, the new form order and blocking unsafe assignments. Some of them need decisions first.
- **Pictures.** They use demo data and a proposed layout. Claude Code is told to copy their look, not their structure.
- **Sidebar.** It keeps the original Porcelain color (`--nw-sidebar`, #FAFBFA in light mode).
