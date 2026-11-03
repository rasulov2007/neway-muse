import { LoadsService } from '../../loads/loads.service';
import { refusal, StaleActionError, type ActionDef } from './types';

/**
 * The pattern every action follows (kept as the reference for the others): plan reads the load
 * and remembers its updatedAt; run hands that updatedAt to the service, whose own version check
 * refuses a stale write; the service writes the audit entry.
 */
export const loadAddNote: ActionDef<{ loadId: string; loadNumber: string; body: string; pinned: boolean; expectedUpdatedAt: string }> = {
  name: 'load_add_note',
  description: 'Add an internal note to a load (optionally pinned so it shows under Instructions). Use when the person asks to write or pin a note on a load.',
  input_schema: {
    type: 'object',
    properties: {
      load_number: { type: 'string', description: 'e.g. L-100005' },
      body: { type: 'string', description: 'The note text, as the person wants it written.' },
      pinned: { type: 'boolean' },
    },
    required: ['load_number', 'body'],
  },
  permission: 'loads.edit',
  risk: 'safe',
  async plan(ctx, principal, input) {
    const number = String(input.load_number ?? '').trim().toUpperCase();
    const body = String(input.body ?? '').trim();
    if (!number) return refusal('Say which load, e.g. L-100005.');
    if (!body) return refusal('Write the note first');
    const load = await ctx.get(LoadsService).get(principal, number).catch(() => null);
    if (!load) return refusal(`There is no load ${number} in this company.`);
    const pinned = input.pinned === true;
    return {
      ok: true,
      title: `${pinned ? 'Pin' : 'Add'} a note on ${load.loadNumber}`,
      lines: [body.slice(0, 300)],
      params: { loadId: load.id, loadNumber: load.loadNumber, body: body.slice(0, 4000), pinned, expectedUpdatedAt: load.updatedAt },
      fingerprint: `load_note:${load.id}:${body.slice(0, 80)}`,
    };
  },
  async run(ctx, principal, p) {
    const now = await ctx.get(LoadsService).get(principal, p.loadId);
    if (now.updatedAt !== p.expectedUpdatedAt) throw new StaleActionError(`${p.loadNumber} changed since the plan.`);
    await ctx.get(LoadsService).addNote(principal, p.loadId, { kind: 'internal', body: p.body, pinned: p.pinned, expectedUpdatedAt: p.expectedUpdatedAt });
    return { text: `Note ${p.pinned ? 'pinned' : 'added'} on ${p.loadNumber}.`, cards: [{ kind: 'link', label: `Open ${p.loadNumber}`, to: `/loads/${encodeURIComponent(p.loadNumber)}` }] };
  },
};
