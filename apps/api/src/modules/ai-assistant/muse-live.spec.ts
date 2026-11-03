import type Anthropic from '@anthropic-ai/sdk';
import { AI_MODELS } from '@neway/shared';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../common/auth/principal';
import { AiAssistantService } from './ai-assistant.service';

/**
 * LIVE: the real assistant loop (server tools + screen tools that pause and resume) answered by
 * the real Muse API. Skipped unless META_API_KEY is set, so CI never calls Meta. The database and
 * the TMS services are stand-ins; the model, the adapter and the loop are the real ones.
 *
 *   META_API_KEY=... npx vitest run src/modules/ai-assistant/muse-live.spec.ts
 */

const me: Principal = {
  userId: 'usr_muse_live',
  userName: 'Muse live spec',
  companyId: 'co_muse_live',
  companyTimezone: 'America/New_York',
  weekStart: 1,
  roles: [],
  permissions: new Set(['ai_assistant.use', 'loads.view', 'accounting.view']),
};

/** A database that accepts the usage rows and reads back nothing spent. */
function fakeDatabase(inserted: unknown[]) {
  const chain = (rows: unknown[]): unknown =>
    new Proxy(() => undefined, {
      get: (_t, prop) => (prop === 'then' ? (ok: (v: unknown) => void) => ok(rows) : () => chain(rows)),
      apply: () => chain(rows),
    });
  return {
    db: {
      insert: () => ({ values: async (v: unknown) => void inserted.push(v) }),
      select: () => chain([{ micros: '0' }]),
    },
  };
}

const load = {
  id: 'load_demo_5',
  loadNumber: 'L-100005',
  status: 'delivered',
  driverName: 'Demo Driver 1',
  truckNumber: '1042',
  stops: [],
  documents: [{ type: 'rate_confirmation', status: 'received', review: 'ok' }],
};

/** What the browser answers for each screen tool. */
function browser(call: { name: string; input: Record<string, unknown> }): string {
  const snap = (route: string, title: string, els: string[]) => `--- screen ---\nRoute: ${route}\nTitle: ${title}\nElements:\n${els.map((e, i) => `[${i + 1}] ${e}`).join('\n')}`;
  if (call.name === 'screen_read') return snap('/dashboard', 'Dashboard', ['link "Loads"', 'link "Invoices"']);
  if (call.name === 'screen_open') return `Opened ${String(call.input.to)}\n${snap(String(call.input.to), 'Load L-100005', ['tab "Documents"', 'button "Upload POD"', 'button "Create invoice" (disabled)'])}`;
  if (call.name === 'screen_click') return `Pressed [${String(call.input.ref)}]\n${snap('/loads/load_demo_5', 'Load L-100005 - Documents', ['button "Upload POD"'])}`;
  return `${call.name}: done`;
}

describe.skipIf(!process.env.META_API_KEY)('NeWay AI on Muse (live)', () => {
  it('finds a load with a server tool and drives the screen, pausing and resuming', { timeout: 300_000 }, async () => {
    const inserted: unknown[] = [];
    const loads = { get: async (_p: Principal, n: string) => (n === 'L-100005' ? load : Promise.reject(new Error('no'))) };
    const problems = { forLoad: async () => [] };
    const invoices = { queue: async () => ({ rows: [{ load: { id: 'load_demo_5' }, verdict: { queue: 'missing_docs', conditions: [{ message: 'POD (proof of delivery) is not on file.' }], rc: { state: 'ok' } }, invoice: null }] }) };
    const ai = new AiAssistantService(fakeDatabase(inserted) as never, invoices as never, {} as never, {} as never, {} as never, loads as never, problems as never, {} as never, {} as never, { get: () => ({}) } as never);
    const svc = ai as unknown as {
      model(id?: string): (typeof AI_MODELS)[number];
      modelClient(): unknown;
      loop(p: Principal, c: { id: string; dryRun: boolean }, m: unknown, client: unknown, h: unknown[], s: unknown): Promise<string>;
      resultsFor(drive: unknown, byId: Map<string, { content: string; is_error: boolean }>, fallback: string): Anthropic.ToolResultBlockParam[];
    };
    const model = svc.model(undefined);
    expect(model.id).toBe('muse-spark-1.3');

    const prompt = 'Find load L-100005, tell me why it cannot be invoiced, and open its page on my screen so I can see it.';
    const state = { turns: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] as Anthropic.MessageParam[], cards: [] as unknown[], finalText: '', steps: 0, drive: null as null | { log: string[]; pending?: Array<{ id: string; name: string; input: Record<string, unknown> }>; steps?: number } };
    const used: string[] = [];
    let end = await svc.loop(me, { id: 'aic_live', dryRun: true }, model, svc.modelClient(), [], state);
    for (let round = 0; end === 'paused' && round < 8; round++) {
      const drive = state.drive!;
      const byId = new Map(drive.pending!.map((p) => (used.push(p.name), [p.id, { content: browser(p), is_error: false }])));
      state.turns.push({ role: 'user', content: svc.resultsFor(drive, byId, 'Not run.') });
      state.drive = { log: drive.log, steps: drive.steps };
      state.steps = drive.steps ?? state.steps;
      end = await svc.loop(me, { id: 'aic_live', dryRun: true }, model, svc.modelClient(), [], state);
    }
    for (const t of state.turns) if (t.role === 'assistant' && Array.isArray(t.content)) for (const b of t.content) if (b.type === 'tool_use' && !used.includes(b.name)) used.push(b.name);

    console.log(`[muse-live] end=${end} steps=${state.steps} tools=${used.join(', ')}\n[muse-live] answer: ${state.finalText}`);
    expect(end).toBe('done');
    expect(used).toContain('find_load');
    expect(used.some((n) => n.startsWith('screen_'))).toBe(true);
    expect(state.finalText).toMatch(/POD|proof of delivery/i);
    expect(inserted.length).toBe(state.steps);
    expect(inserted.every((r) => (r as { model: string }).model === 'muse-spark-1.3')).toBe(true);
  });

  it('the one-shot complete() (driver app "Ask NeWay") answers through Muse too', { timeout: 120_000 }, async () => {
    const inserted: unknown[] = [];
    const ai = new AiAssistantService(fakeDatabase(inserted) as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never, { get: () => ({}) } as never);
    const text = await ai.complete(me, { system: 'Answer in one short sentence from these facts only: next stop Dallas TX, appointment 14:00 Central.', messages: [{ role: 'user', text: 'Where is my next stop?' }] });
    console.log(`[muse-live] complete(): ${text}`);
    expect(text).toMatch(/Dallas/i);
    expect((inserted[0] as { model: string }).model).toBe('muse-spark-1.3');
  });
});
