import { demoData } from './data';
import { saveSoon } from './state-persist';

/**
 * What an expired unit document does: stops dispatch, or only warns.
 *
 * The catalog ships a default per type (a regulatory hold blocks; a lease agreement warns), and an
 * administrator can change it per type here. Stored in the workspace beside the fleet's other
 * settings; read by the fleet bundle when it derives a unit's availability.
 */
export type UnitDocumentRule = 'block' | 'warn';

export function unitDocumentRules(): Record<string, UnitDocumentRule> {
  return demoData.unitDocumentRules ?? {};
}

export async function setUnitDocumentRule(
  code: string,
  rule: UnitDocumentRule | null,
): Promise<Record<string, UnitDocumentRule>> {
  const next = { ...unitDocumentRules() };
  if (rule === null) delete next[code];
  else next[code] = rule;
  demoData.unitDocumentRules = next;
  saveSoon();
  return next;
}
