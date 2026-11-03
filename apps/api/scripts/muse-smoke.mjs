#!/usr/bin/env node
/**
 * Muse smoke test (not run in CI): one real tool-calling round trip through NeWay AI's Muse
 * adapter, the same `create()` the assistant loop calls. The model gets a server tool (find_load)
 * and the real screen_* tools; this script plays the server and the browser with canned results
 * and prints only what the model says and which tools it calls.
 *
 *   node apps/api/scripts/muse-smoke.mjs [model]        (Node 22.6+; loads the .ts adapter by type stripping)
 *
 * The key comes from META_API_KEY or the owner's key file (LLAMA_API_KEY=...). It is never printed.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const { MuseClient } = await import('../src/modules/ai-assistant/muse-client.ts');
const { SCREEN_TOOLS, SCREEN_PROMPT } = await import('../src/modules/ai-assistant/screen-tools.ts');

function key() {
  if (process.env.META_API_KEY) return process.env.META_API_KEY;
  const file = process.env.META_KEY_FILE ?? join(homedir(), '.neway-secrets', 'meta-llama.env');
  const m = readFileSync(file, 'utf8').match(/^\s*(?:LLAMA_API_KEY|META_API_KEY)\s*=\s*(.+)\s*$/m);
  if (!m) throw new Error(`No LLAMA_API_KEY in ${file}`);
  return m[1].trim().replace(/^["']|["']$/g, '');
}

const model = process.argv[2] ?? 'muse-spark-1.3';
const client = new MuseClient({ apiKey: key(), reasoningEffort: 'low', timeoutMs: 90_000, retries: 1 });

const tools = [
  {
    name: 'find_load',
    description: 'One load by its number (e.g. L-100005): status, driver, truck, stops, documents on file, open flags, invoice, and what the billing check says is missing.',
    input_schema: { type: 'object', properties: { load_number: { type: 'string' } }, required: ['load_number'] },
  },
  ...SCREEN_TOOLS,
];

const snapshot = (route, title, elements) =>
  `Opened ${route}\n--- screen ---\nRoute: ${route}\nTitle: ${title}\nElements:\n${elements.map((e, i) => `[${i + 1}] ${e}`).join('\n')}`;

/** What the server / the browser would answer. */
function run(call) {
  switch (call.name) {
    case 'find_load':
      return JSON.stringify({ load: 'L-100005', id: 'load_demo_5', status: 'delivered', driver: 'Demo Driver 1', truck: '1042', billing: { canInvoice: false, missing: ['POD (proof of delivery)'] } });
    case 'screen_read':
      return snapshot('/dashboard', 'Dashboard', ['link "Loads"', 'link "Invoices"', 'button "Add load"']).replace('Opened /dashboard\n', '');
    case 'screen_open':
      return snapshot(call.input.to, 'Load L-100005', ['tab "Overview"', 'tab "Documents"', 'button "Upload POD"', 'button "Create invoice" (disabled)']);
    case 'screen_click':
      return `Clicked [${call.input.ref}]\n--- screen ---\nRoute: /loads/load_demo_5\nTitle: Load L-100005 - Documents\nElements:\n[1] button "Upload POD"`;
    default:
      return `${call.name}: done`;
  }
}

const messages = [{ role: 'user', content: 'Find load L-100005, tell me why it cannot be invoiced, and open its page on my screen so I can see it.' }];
console.log(`model: ${model}`);
console.log(`> ${messages[0].content}`);
for (let step = 1; step <= 6; step++) {
  const t0 = Date.now();
  const resp = await client.create({
    model,
    max_tokens: 3000,
    system: ['You are NeWay AI, the assistant inside NeWay TMS. Use the tools for every fact about loads.', 'Pages that exist: /dashboard, /loads, /loads/$loadId, /accounting/invoices.', SCREEN_PROMPT].join('\n'),
    tools,
    messages,
  });
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[step ${step}] ${resp.model} stop=${resp.stop_reason} tokens in/out=${resp.usage.input_tokens}/${resp.usage.output_tokens} ${secs}s`);
  for (const b of resp.content) {
    if (b.type === 'text') console.log(`  text: ${b.text}`);
    if (b.type === 'tool_use') console.log(`  tool_use ${b.id}: ${b.name} ${JSON.stringify(b.input)}`);
  }
  messages.push({ role: 'assistant', content: resp.content });
  const calls = resp.content.filter((b) => b.type === 'tool_use');
  if (resp.stop_reason !== 'tool_use' || calls.length === 0) {
    const used = new Set(messages.flatMap((m) => (Array.isArray(m.content) ? m.content.filter((b) => b.type === 'tool_use').map((b) => b.name) : [])));
    const ok = used.has('find_load') && [...used].some((n) => n.startsWith('screen_'));
    console.log(`\n${ok ? 'OK' : 'INCOMPLETE'}: tools used = ${[...used].join(', ') || '(none)'}`);
    process.exit(ok ? 0 : 1);
  }
  messages.push({ role: 'user', content: calls.map((c) => ({ type: 'tool_result', tool_use_id: c.id, content: run(c) })) });
}
console.log('\nINCOMPLETE: step limit reached');
process.exit(1);
