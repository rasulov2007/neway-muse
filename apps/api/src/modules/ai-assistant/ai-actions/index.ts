import type Anthropic from '@anthropic-ai/sdk';
import { loadAddNote } from './example-load-note';
import { FLEET_ACTIONS } from './fleet';
import { INVOICE_ACTIONS } from './invoices';
import { LOAD_ACTIONS } from './loads';
import { SETTLEMENT_ACTIONS } from './settlements';
import type { ActionDef } from './types';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const AI_ACTIONS: ActionDef<any>[] = [loadAddNote, ...LOAD_ACTIONS, ...INVOICE_ACTIONS, ...SETTLEMENT_ACTIONS, ...FLEET_ACTIONS];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ACTION_BY_NAME = new Map<string, ActionDef<any>>(AI_ACTIONS.map((a) => [a.name, a]));

/** The actions as tools for the model; the card the person sees says whether it ran or waits. */
export function actionTools(): Anthropic.Tool[] {
  return AI_ACTIONS.map((a) => ({
    name: a.name,
    description: `${a.description} ${a.risk === 'safe' ? 'Runs at once when Dry run is off.' : 'Shows a confirmation card; nothing happens until the person presses Confirm.'}`,
    input_schema: a.input_schema,
  }));
}
