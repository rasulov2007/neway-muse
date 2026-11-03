import type Anthropic from '@anthropic-ai/sdk';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { aiConversations, aiMessages, aiProposals, aiUsage } from '../src/database/schema';
import { AiAssistantService, type AiModelClient } from '../src/modules/ai-assistant/ai-assistant.service';
import { searchGuide } from '../src/modules/ai-assistant/knowledge';
import { LoadsService } from '../src/modules/loads/loads.service';

/**
 * NeWay AI, Phase 1 (owner, 2026-10-20), with a scripted model instead of Anthropic: tools run
 * through the services with the person's permissions, the answer's cards come from the tools,
 * usage is counted, the monthly cap refuses, chats are private, and a proposal never runs in Dry
 * run. Removes what it wrote.
 */
describe('NeWay AI (e2e)', () => {
  let app: NestFastifyApplication;
  let ai: AiAssistantService;
  const conversations: string[] = [];
  const me: Principal = { userId: 'usr_ai_spec', userName: 'AI spec', companyId: 'co_northwind', companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set(['ai_assistant.use', 'accounting.view', 'accounting.edit']) };
  const someoneElse: Principal = { ...me, userId: 'usr_ai_other', permissions: new Set(['ai_assistant.use']) };

  /** A model that answers from a script: each call takes the next reply. */
  const scripted = (replies: Array<Partial<Anthropic.Message>>): AiModelClient & { calls: Anthropic.MessageCreateParamsNonStreaming[] } => {
    const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
    return {
      calls,
      create: async (params) => {
        calls.push(params);
        const r = replies.shift() ?? { content: [{ type: 'text', text: 'done', citations: null }], stop_reason: 'end_turn' };
        return { id: 'msg', type: 'message', role: 'assistant', model: params.model, stop_sequence: null, usage: { input_tokens: 1000, output_tokens: 200 }, ...r } as Anthropic.Message;
      },
    };
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    ai = app.get(AiAssistantService);
  }, 120_000);

  afterAll(async () => {
    ai.setClient(null);
    const db = app.get(DatabaseService).db;
    if (conversations.length) {
      await db.delete(aiProposals).where(inArray(aiProposals.conversationId, conversations));
      await db.delete(aiMessages).where(inArray(aiMessages.conversationId, conversations));
      await db.delete(aiUsage).where(inArray(aiUsage.conversationId, conversations));
      await db.delete(aiConversations).where(inArray(aiConversations.id, conversations));
    }
    await db.delete(aiUsage).where(eq(aiUsage.userId, 'usr_ai_cap'));
    await app?.close();
  });

  it('answers with a tool, shows its card, counts the cost, and keeps the chat private', async () => {
    const conv = await ai.create(me, {});
    conversations.push(conv.id);
    expect(conv.dryRun).toBe(true);
    const model = scripted([
      { content: [{ type: 'tool_use', id: 'tu1', name: 'list_overdue_invoices', input: { min_days_past_due: 0 }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock], stop_reason: 'tool_use' },
      { content: [{ type: 'text', text: 'Here are the unpaid invoices.', citations: null }], stop_reason: 'end_turn' },
    ]);
    ai.setClient(model);
    const r = await ai.send(me, conv.id, { text: 'Overdue invoicelarni ko‘rsat', attachmentFileIds: [] });
    expect(r.messages).toHaveLength(2);
    const bot = r.messages[1]!;
    expect(bot.text).toBe('Here are the unpaid invoices.');
    expect(bot.cards[0]?.kind).toBe('table');
    // The second call carried the tool result back.
    const last = model.calls[1]!.messages.at(-1)!;
    expect(Array.isArray(last.content) && last.content[0]?.type).toBe('tool_result');
    expect(r.usage.monthCostCents).toBeGreaterThanOrEqual(0);
    expect(r.conversation.title).toContain('Overdue');
    // Nobody else sees it.
    await expect(ai.messages(someoneElse, conv.id)).rejects.toThrow(/No such conversation/);
    expect((await ai.conversations(someoneElse)).some((c) => c.id === conv.id)).toBe(false);
  });

  it('refuses a tool the person has no permission for, and the model hears why', async () => {
    const conv = await ai.create(someoneElse, {});
    conversations.push(conv.id);
    ai.setClient(scripted([{ content: [{ type: 'tool_use', id: 'tu2', name: 'billing_queue', input: {}, caller: { type: 'direct' } } as Anthropic.ToolUseBlock], stop_reason: 'tool_use' }]));
    const r = await ai.send(someoneElse, conv.id, { text: 'billing queue', attachmentFileIds: [] });
    const notice = r.messages[1]!.cards.find((c) => c.kind === 'notice');
    expect(notice && notice.kind === 'notice' && notice.text).toMatch(/accounting\.view/);
  });

  it('prepares an RTS proposal it cannot run in Dry run, and blocks unknown invoices', async () => {
    const conv = await ai.create(me, {});
    conversations.push(conv.id);
    ai.setClient(scripted([{ content: [{ type: 'tool_use', id: 'tu3', name: 'propose_rts_submission', input: { invoice_ids: ['inv_does_not_exist'] }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock], stop_reason: 'tool_use' }]));
    const r = await ai.send(me, conv.id, { text: 'send to RTS', attachmentFileIds: [] });
    const card = r.messages[1]!.cards.find((c) => c.kind === 'proposal');
    expect(card && card.kind === 'proposal' && card.blocked[0]).toMatch(/not an invoice of this company/);
    expect(card && card.kind === 'proposal' && card.status).toBe('cancelled');
    // An awaiting proposal still cannot run while Dry run is on.
    const db = app.get(DatabaseService).db;
    await db.insert(aiProposals).values({ id: 'aip_spec_dry', companyId: me.companyId, userId: me.userId, conversationId: conv.id, action: 'rts_submission', params: { items: [] }, card: {}, status: 'awaiting', fingerprint: 'rts:' });
    await expect(ai.confirm(me, 'aip_spec_dry')).rejects.toThrow(/Dry run is on/);
    await expect(ai.update(me, conv.id, { dryRun: false })).rejects.toThrow(/Only an administrator/);
  });

  it('teaches from the TMS guide and points at the page', async () => {
    const found = searchGuide('how do I issue an invoice', 2);
    expect(found.length).toBeGreaterThan(0);
    const conv = await ai.create(me, {});
    conversations.push(conv.id);
    ai.setClient(scripted([{ content: [{ type: 'tool_use', id: 'tu4', name: 'tms_guide', input: { question: 'issue invoice' }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock], stop_reason: 'tool_use' }]));
    const r = await ai.send(me, conv.id, { text: 'Qanday invoice chiqaraman?', attachmentFileIds: [] });
    expect(r.messages[1]!.cards.some((c) => c.kind === 'link')).toBe(true);
  });

  it('says a load is not in the company instead of guessing', async () => {
    const conv = await ai.create(me, {});
    conversations.push(conv.id);
    ai.setClient(scripted([{ content: [{ type: 'tool_use', id: 'tu5', name: 'find_load', input: { load_number: 'L-999999' }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock], stop_reason: 'tool_use' }]));
    const withLoads: Principal = { ...me, permissions: new Set([...me.permissions, 'loads.view']) };
    const r = await ai.send(withLoads, conv.id, { text: 'L-999999 nega invoice bolmayapti', attachmentFileIds: [] });
    const notice = r.messages[1]!.cards.find((c) => c.kind === 'notice');
    expect(notice && notice.kind === 'notice' && notice.text).toMatch(/no load L-999999/);
  });

  it('carries out an everyday action itself only when Dry run is off, and audits it', async () => {
    const loads = await app.get(LoadsService).list(me, { includeDemo: true });
    const load = loads.find((l) => typeof l.loadNumber === 'string' && /^L-/.test(l.loadNumber));
    expect(load).toBeDefined();
    const doer: Principal = { ...me, permissions: new Set([...me.permissions, 'loads.view', 'loads.edit']) };
    const body = `AI spec note ${Date.now()}`;
    const conv = await ai.create(doer, {});
    conversations.push(conv.id);
    const call = { content: [{ type: 'tool_use', id: 'tu6', name: 'load_add_note', input: { load_number: load!.loadNumber, body }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock], stop_reason: 'tool_use' as const };

    // Dry run: planned, not done.
    ai.setClient(scripted([call]));
    const dry = await ai.send(doer, conv.id, { text: 'note', attachmentFileIds: [] });
    const planned = dry.messages[1]!.cards.find((c) => c.kind === 'proposal');
    expect(planned && planned.kind === 'proposal' && planned.status).toBe('awaiting');
    expect((await app.get(LoadsService).get(doer, load!.id)).notes.some((n) => n.body === body)).toBe(false);

    // Dry run off: the same kind of request runs at once.
    const db = app.get(DatabaseService).db;
    await db.update(aiProposals).set({ status: 'cancelled' }).where(eq(aiProposals.conversationId, conv.id));
    await db.update(aiConversations).set({ dryRun: false }).where(eq(aiConversations.id, conv.id));
    ai.setClient(scripted([{ ...call, content: [{ ...(call.content[0] as Anthropic.ToolUseBlock), id: 'tu7' }] }]));
    const live = await ai.send(doer, conv.id, { text: 'note', attachmentFileIds: [] });
    const done = live.messages[1]!.cards.find((c) => c.kind === 'proposal');
    expect(done && done.kind === 'proposal' && done.status).toBe('executed');
    expect((await app.get(LoadsService).get(doer, load!.id)).notes.some((n) => n.body === body)).toBe(true);
  });

  describe('drives the screen (pause and resume)', () => {
    const click = (id: string, ref = 3) => ({ content: [{ type: 'text', text: 'Pressing “Create invoice”.', citations: null } as Anthropic.TextBlock, { type: 'tool_use', id, name: 'screen_click', input: { ref }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock], stop_reason: 'tool_use' as const });

    it('hands screen tools to the browser, resumes with their results and finishes', async () => {
      const conv = await ai.create(me, {});
      conversations.push(conv.id);
      const model = scripted([
        // A server tool and a screen tool in one turn: the server one runs, the screen one waits.
        { content: [{ type: 'tool_use', id: 'g1', name: 'tms_guide', input: { question: 'create invoice' }, caller: { type: 'direct' } } as Anthropic.ToolUseBlock, ...click('sc1').content.slice(1)], stop_reason: 'tool_use' },
        click('sc2', 5),
        { content: [{ type: 'text', text: 'The invoice form is open.', citations: null }], stop_reason: 'end_turn' },
      ]);
      ai.setClient(model);
      const first = await ai.send(me, conv.id, { text: 'Create an invoice for me', attachmentFileIds: [] });
      const bot = first.messages[1]!;
      expect(bot.pendingClientTools).toEqual([{ id: 'sc1', name: 'screen_click', input: { ref: 3 } }]);
      expect(bot.cards[0]).toMatchObject({ kind: 'drive', status: 'running' });
      // Nothing server-only reaches the browser.
      expect(JSON.stringify(bot.cards)).not.toMatch(/pauseId|held/);
      expect(model.calls).toHaveLength(1);
      // The screen tools are offered to the model.
      expect(model.calls[0]!.tools!.some((t) => 'name' in t && t.name === 'screen_read')).toBe(true);

      // Mismatched ids are refused, and so is a result the model never asked for.
      await expect(ai.clientResults(me, conv.id, { messageId: bot.id, results: [{ tool_use_id: 'sc_forged', content: 'x', is_error: false }], stop: false })).rejects.toThrow(/do not match/);
      await expect(
        ai.clientResults(me, conv.id, { messageId: bot.id, results: [{ tool_use_id: 'sc1', content: 'x', is_error: false }, { tool_use_id: 'g1', content: 'x', is_error: false }], stop: false }),
      ).rejects.toThrow(/do not match/);
      // Another person's conversation does not exist for them.
      await expect(ai.clientResults(someoneElse, conv.id, { messageId: bot.id, results: [{ tool_use_id: 'sc1', content: 'x', is_error: false }], stop: false })).rejects.toThrow(/No such conversation/);

      const second = await ai.clientResults(me, conv.id, { messageId: bot.id, results: [{ tool_use_id: 'sc1', content: 'Clicked ‘Create invoice’.\n--- screen ---\n[5] button "Save"', is_error: false }], stop: false });
      const again = second.messages[0]!;
      expect(again.id).toBe(bot.id);
      expect(again.pendingClientTools?.[0]?.id).toBe('sc2');
      // The resumed request carried both results of the paused turn, in the model's order.
      const resumed = model.calls[1]!.messages.at(-1)!;
      expect(Array.isArray(resumed.content) && resumed.content.map((b) => (b.type === 'tool_result' ? b.tool_use_id : b.type))).toEqual(['g1', 'sc1']);
      // The same results cannot be posted twice.
      await expect(ai.clientResults(me, conv.id, { messageId: bot.id, results: [{ tool_use_id: 'sc1', content: 'x', is_error: false }], stop: false })).rejects.toThrow(/do not match/);

      const done = await ai.clientResults(me, conv.id, { messageId: bot.id, results: [{ tool_use_id: 'sc2', content: 'Clicked ‘Save’.', is_error: false }], stop: false });
      const last = done.messages[0]!;
      expect(last.pendingClientTools).toBeUndefined();
      expect(last.text).toBe('The invoice form is open.');
      expect(last.cards[0]).toEqual({ kind: 'drive', status: 'done', log: ['Clicked ‘Create invoice’.', 'Clicked ‘Save’.'] });
      await expect(ai.clientResults(me, conv.id, { messageId: bot.id, results: [{ tool_use_id: 'sc2', content: 'x', is_error: false }], stop: false })).rejects.toThrow(/not waiting/);

      // The stored transcript is valid for the next message: every call has its result.
      ai.setClient(scripted([{ content: [{ type: 'text', text: 'ok', citations: null }], stop_reason: 'end_turn' }]));
      const next = await ai.send(me, conv.id, { text: 'thanks', attachmentFileIds: [] });
      expect(next.messages[1]!.text).toBe('ok');
    });

    it('Stop records the step as cancelled without asking the model again; a new message closes a waiting run', async () => {
      const conv = await ai.create(me, {});
      conversations.push(conv.id);
      const model = scripted([click('st1'), click('st2')]);
      ai.setClient(model);
      const first = await ai.send(me, conv.id, { text: 'press it', attachmentFileIds: [] });
      const stopped = await ai.clientResults(me, conv.id, { messageId: first.messages[1]!.id, results: [{ tool_use_id: 'st1', content: 'Cancelled: the person pressed Stop.', is_error: true }], stop: true });
      expect(stopped.messages[0]!.cards[0]).toMatchObject({ kind: 'drive', status: 'stopped' });
      expect(model.calls).toHaveLength(1);

      // A run left waiting is closed when the person writes again.
      const waiting = await ai.send(me, conv.id, { text: 'press it again', attachmentFileIds: [] });
      expect(waiting.messages[1]!.pendingClientTools?.[0]?.id).toBe('st2');
      ai.setClient(scripted([{ content: [{ type: 'text', text: 'fine', citations: null }], stop_reason: 'end_turn' }]));
      await ai.send(me, conv.id, { text: 'never mind', attachmentFileIds: [] });
      const all = await ai.messages(me, conv.id);
      const closed = all.find((m) => m.id === waiting.messages[1]!.id)!;
      expect(closed.cards[0]).toMatchObject({ kind: 'drive', status: 'stopped' });
      expect(closed.pendingClientTools).toBeUndefined();
    });
  });

  it('stops at the monthly cap', async () => {
    const conv = await ai.create(me, {});
    conversations.push(conv.id);
    const db = app.get(DatabaseService).db;
    await db.insert(aiUsage).values({ id: 'aiu_spec_cap', companyId: me.companyId, userId: 'usr_ai_cap', model: 'claude-haiku-4-5', inputTokens: 0, outputTokens: 0, costMicros: 10_000_000_000 });
    await expect(ai.send(me, conv.id, { text: 'hi', attachmentFileIds: [] })).rejects.toThrow(/budget/);
    expect((await ai.usage(me)).blocked).toBe(true);
  });
});
