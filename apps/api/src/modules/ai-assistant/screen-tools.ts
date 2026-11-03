import type Anthropic from '@anthropic-ai/sdk';
import { AI_SCREEN_TOOL_NAMES, type AiScreenToolName } from '@neway/shared';

/**
 * "NeWay AI drives the screen" (owner, 2026-10-21): tools the model calls that the BROWSER runs,
 * with a visible cursor, in the person's own session - so the app's own permissions, disabled
 * buttons and confirmations apply. The server never runs these: it pauses the loop, hands the
 * calls to the web as `pendingClientTools`, and resumes when the web posts the results.
 */

const SCREEN_NAMES = new Set<string>(AI_SCREEN_TOOL_NAMES);
export const isScreenTool = (name: string): name is AiScreenToolName => SCREEN_NAMES.has(name);

const ref = { type: 'integer', description: 'The [number] of the element in the latest screen_read snapshot.' } as const;

export const SCREEN_TOOLS: Anthropic.Tool[] = [
  {
    name: 'screen_read',
    description:
      'Read the screen the person is looking at: the route, page title, open dialogs, headings, alerts/toasts, a short excerpt of the visible text, and a numbered list of the interactive elements (buttons, links, tabs, menu items, fields with their labels and values, checkboxes, row actions). Call it before acting and after every navigation. Numbers are valid only for that snapshot.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'screen_click',
    description: 'Move the visible cursor to an element and press it (button, link, tab, menu item, checkbox, row action). Returns what happened and a fresh snapshot. Risky buttons (approve, post, pay, send, issue, delete, void…) ask the person first; with Dry run on they are not pressed.',
    input_schema: { type: 'object', properties: { ref }, required: ['ref'] },
  },
  {
    name: 'screen_type',
    description: 'Type text into a field (input or textarea), character by character, as the person would. Use clear=true to replace what is there. Never invent a value the person did not give or a record does not show - ask instead.',
    input_schema: { type: 'object', properties: { ref, text: { type: 'string' }, clear: { type: 'boolean', description: 'Empty the field first (default true).' } }, required: ['ref', 'text'] },
  },
  {
    name: 'screen_select',
    description: 'Choose an option in a select / dropdown field by its visible text.',
    input_schema: { type: 'object', properties: { ref, option: { type: 'string', description: 'Visible text of the option.' } }, required: ['ref', 'option'] },
  },
  {
    name: 'screen_press',
    description: 'Press a key on the focused element: Enter, Escape or Tab.',
    input_schema: { type: 'object', properties: { key: { type: 'string', enum: ['Enter', 'Escape', 'Tab'] } }, required: ['key'] },
  },
  {
    name: 'screen_open',
    description: 'Open a TMS page by its web route (from the Pages list, e.g. /accounting/invoices). Returns a snapshot of the new page once it has loaded.',
    input_schema: { type: 'object', properties: { to: { type: 'string', description: 'Web route starting with /' } }, required: ['to'] },
  },
  {
    name: 'screen_scroll',
    description: 'Scroll the page (or the element ref, e.g. a table or panel) up or down to reveal more.',
    input_schema: { type: 'object', properties: { ref, direction: { type: 'string', enum: ['up', 'down'] } }, required: ['direction'] },
  },
  {
    name: 'screen_wait',
    description: 'Wait until "Loading…" is gone and, if given, until a text appears on the screen (at most 10 seconds). Returns a fresh snapshot.',
    input_schema: { type: 'object', properties: { forText: { type: 'string' }, ms: { type: 'integer', description: 'Longest wait in milliseconds, up to 10000.' } } },
  },
];

/** What the system prompt says about driving the screen. */
export const SCREEN_PROMPT = [
  'You can DRIVE THE SCREEN like a person: the screen_* tools move a visible cursor in the person’s own browser, open pages, press buttons, type into fields and choose options while the person watches. The app enforces the person’s own permissions; a disabled control stays disabled - never try to get around it.',
  'Use the screen tools when the person asks you to do something in the TMS and wants to see it happen, says "show me", "do it for me", "click", "fill in", or asks how to do something and would learn by watching. Prefer the server action tools only when the person did not ask to see it happen.',
  'Before acting, call screen_read; after screen_open or any click that changes the page, read the new snapshot the tool returns before the next step. Element numbers change with every snapshot - use only numbers from the latest one.',
  'Teach while working: before each screen step write ONE short sentence saying what you are pressing and why (e.g. "Pressing “Create invoice” to start a new invoice."). Keep it to one line per step.',
  'If a field needs a value the person did not give and no record shows, STOP and ask for it. Never invent names, amounts, dates or numbers.',
  'Risky buttons (approve, post, pay, record payment, send, submit, issue, delete, remove, void, cancel load, reopen, sign, transfer, apply, disable) ask the person before pressing; with Dry run on they are not pressed and the tool says "dry run: would press …" - then explain what would happen and go on describing the rest.',
  'If the person stops you or does not allow a step, do not try again; say where you stopped.',
].join('\n');

/** Screen snapshots are long; only the newest ones stay whole in the request. */
const KEEP_SNAPSHOTS = 2;
const SNAPSHOT_MARK = '\n--- screen ---\n';

export function compactScreenResults(turns: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  let seen = 0;
  const out = [...turns];
  for (let i = out.length - 1; i >= 0; i--) {
    const turn = out[i]!;
    if (turn.role !== 'user' || !Array.isArray(turn.content)) continue;
    let changed = false;
    const content = turn.content.map((b) => {
      if (b.type !== 'tool_result' || typeof b.content !== 'string') return b;
      const at = b.content.indexOf(SNAPSHOT_MARK);
      if (at < 0) return b;
      seen++;
      if (seen <= KEEP_SNAPSHOTS) return b;
      changed = true;
      return { ...b, content: `${b.content.slice(0, at)}\n(older screen snapshot left out)` };
    });
    if (changed) out[i] = { ...turn, content };
  }
  return out;
}

/** One log line for the person from what the browser reported (its first line). */
export function screenLogLine(name: string, content: string): string | null {
  if (name === 'screen_read') return null;
  const first = content.split('\n')[0]?.trim() ?? '';
  return first ? first.slice(0, 140) : null;
}
