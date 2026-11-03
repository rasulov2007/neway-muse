/**
 * Which presses NeWay AI must ask about first (owner rule: confirm only risky actions). A press is
 * risky when the control's name carries one of these verbs as a whole word: approve, post, pay,
 * record payment, send, submit, issue, delete, remove, void, cancel load, reopen, sign, transfer,
 * apply, disable. "Cancel" alone, "Close", tabs and "Apply filters" are not.
 */
const RISKY_WORDS = /\b(approve|post|pay|send|submit|issue|delete|remove|void|reopen|sign|transfer|apply|disable)\b/i;
const RISKY_PHRASES = /\b(record payment|cancel load)\b/i;
const HARMLESS = /\bapply\s+filters?\b/i;

/** The risky verb in a control's name, or null. `role` = the control's role ("tab" is never risky). */
export function riskyVerb(name: string, role = 'button'): string | null {
  if (role === 'tab' || role === 'textbox' || role === 'option') return null;
  const n = name.replace(/\s+/g, ' ').trim();
  const phrase = RISKY_PHRASES.exec(n);
  if (phrase) return phrase[1]!.toLowerCase();
  if (HARMLESS.test(n)) return null;
  const word = RISKY_WORDS.exec(n);
  return word ? word[1]!.toLowerCase() : null;
}
