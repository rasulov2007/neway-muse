import { z } from 'zod';

/**
 * NeWay AI - Phase 1, the Accounting assistant (owner brief, 2026-10-20).
 *
 * The assistant answers from TMS records through tools that wrap the existing services; money is
 * computed by those services, never by the model. Anything that changes something - an RTS
 * submission, an email, an approval - is a server-stored proposal the person confirms on screen,
 * and nothing executes while Dry run is on.
 */

export interface AiModelDef {
  id: string;
  label: string;
  /** "Fast" or "Advanced", as the selector shows it. */
  role: string;
  vision: boolean;
  /** Who runs it: Anthropic (Claude) or Meta (Muse). The server routes each id to its client. */
  provider: 'anthropic' | 'meta';
  /** USD per million tokens. Configurable on the server; these are the defaults. */
  inputPerMTok: number;
  outputPerMTok: number;
}

/**
 * The models the selector offers, preferred first. IDs checked against Anthropic's model list
 * (2026-10-20): there is no "Haiku 5.5"; Haiku 4.5 is the current small model.
 *
 * Meta Muse (2026-11-03) is offered only when the server has a Meta key, and is then the default;
 * Claude stays as the fallback when a Muse call fails. TODO(owner): Meta has not given us Muse
 * prices yet - the Muse figures below are PLACEHOLDERS (set equal to the Claude models of the same
 * tier so the monthly cap keeps working). Replace them with Meta's real per-token prices.
 */
export const AI_MODELS: readonly AiModelDef[] = [
  { id: 'muse-spark-1.3', label: 'Muse Spark (Meta)', role: 'Fast', vision: true, provider: 'meta', inputPerMTok: 1, outputPerMTok: 5 },
  { id: 'muse-wonder-1.0', label: 'Muse Wonder (Meta)', role: 'Deep', vision: true, provider: 'meta', inputPerMTok: 2, outputPerMTok: 10 },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', role: 'Fast', vision: true, provider: 'anthropic', inputPerMTok: 1, outputPerMTok: 5 },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', role: 'Advanced', vision: true, provider: 'anthropic', inputPerMTok: 2, outputPerMTok: 10 },
];
/** The Claude default: the model when the server has no Meta key, and Muse's fallback. */
export const AI_DEFAULT_MODEL = 'claude-haiku-4-5';
/** The default when the server has a Meta key. */
export const AI_MUSE_DEFAULT_MODEL = 'muse-spark-1.3';
/** The company's monthly AI budget unless set otherwise (owner, 2026-10-20). */
export const AI_MONTHLY_CAP_USD = 20;
/** Warn at this share of the cap. */
export const AI_CAP_WARN_SHARE = 0.8;

export const aiCostMicros = (model: AiModelDef, input: number, output: number): number =>
  Math.round(input * model.inputPerMTok + output * model.outputPerMTok);

// ------------------------------------------------------------------------------ requests

export const CreateAiConversationSchema = z.object({
  title: z.string().trim().max(120).optional(),
  model: z.string().max(60).optional(),
});
export type CreateAiConversationInput = z.infer<typeof CreateAiConversationSchema>;

export const UpdateAiConversationSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  model: z.string().max(60).optional(),
  dryRun: z.boolean().optional(),
});
export type UpdateAiConversationInput = z.infer<typeof UpdateAiConversationSchema>;

export const SendAiMessageSchema = z.object({
  text: z.string().trim().min(1, 'Write a message').max(8000),
  model: z.string().max(60).optional(),
  /** Stored files (images, PDFs) the person attached. */
  attachmentFileIds: z.array(z.string().min(1)).max(5).default([]),
});
export type SendAiMessageInput = z.infer<typeof SendAiMessageSchema>;

// ------------------------------------------------------------------------------ views

export interface AiTableCard {
  kind: 'table';
  title: string;
  columns: string[];
  rows: string[][];
  /** Shown under the table: "Showing 25 of 40", what was left out. */
  note?: string;
}

export type AiProposalStatus = 'awaiting' | 'confirmed' | 'executed' | 'failed' | 'cancelled' | 'stale';

export interface AiProposalCard {
  kind: 'proposal';
  proposalId: string;
  action: string;
  title: string;
  lines: string[];
  count: number;
  totalCents: number | null;
  destination: string | null;
  blocked: string[];
  status: AiProposalStatus;
  result: string | null;
  /** safe = ran (or runs) without a Confirm; confirm = waits for the person. Missing on older cards. */
  risk?: 'safe' | 'confirm';
  warnings?: string[];
}

export interface AiNoticeCard {
  kind: 'notice';
  tone: 'info' | 'warning' | 'danger';
  text: string;
}

/** A document the person can download: an API path the web fetches with the session. */
export interface AiFileCard {
  kind: 'file';
  title: string;
  /** API path under /api/v1, e.g. /accounting/settlements/stl_1/pdf. */
  path: string;
  fileName: string;
}

/** A page in the TMS the answer points to; the web opens it. */
export interface AiLinkCard {
  kind: 'link';
  label: string;
  /** Web route, e.g. /accounting/invoices. */
  to: string;
}

/** Show me: open a page and point at the control to press. */
export interface AiGuideCard {
  kind: 'guide';
  /** Web route to open. */
  to: string;
  /** Visible label of the button, tab or field to point at. */
  target: string;
  /** What to tell the person beside it. */
  hint: string;
}

/**
 * NeWay AI drove the screen (owner, 2026-10-21): the run's state and what it pressed, one line per
 * step. `running` means the browser still owes the results of `pendingClientTools`.
 */
export interface AiDriveCard {
  kind: 'drive';
  status: 'running' | 'done' | 'stopped' | 'limit';
  /** Short lines, newest last: "Clicked ‘Create invoice’". */
  log: string[];
}

export type AiCard = AiTableCard | AiProposalCard | AiNoticeCard | AiFileCard | AiLinkCard | AiGuideCard | AiDriveCard;

/** The screen tools the browser runs for the model ("NeWay AI drives the screen"). */
export const AI_SCREEN_TOOL_NAMES = ['screen_read', 'screen_click', 'screen_type', 'screen_select', 'screen_press', 'screen_open', 'screen_scroll', 'screen_wait'] as const;
export type AiScreenToolName = (typeof AI_SCREEN_TOOL_NAMES)[number];

/** A tool call the browser must run before the model can go on. */
export interface AiClientToolCall {
  id: string;
  name: AiScreenToolName;
  input: Record<string, unknown>;
}

export const AiClientResultsSchema = z.object({
  /** The assistant message whose tool calls these answer. */
  messageId: z.string().min(1).max(80),
  results: z
    .array(
      z.object({
        tool_use_id: z.string().min(1).max(120),
        content: z.string().max(24_000),
        is_error: z.boolean().default(false),
      }),
    )
    .max(50),
  /** The person pressed Stop: record the results, do not ask the model again. */
  stop: z.boolean().default(false),
});
export type AiClientResultsInput = z.infer<typeof AiClientResultsSchema>;

export interface AiMessageView {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  cards: AiCard[];
  model: string | null;
  attachments: Array<{ fileId: string; fileName: string; contentType: string }>;
  createdAt: string;
  /** Screen tools the browser has to run now, in order, then post back. Only on a running drive. */
  pendingClientTools?: AiClientToolCall[];
}

export interface AiConversationView {
  id: string;
  title: string;
  model: string;
  dryRun: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface AiUsageView {
  monthCostCents: number;
  capCents: number;
  /** True once the month's spend has reached the cap: sending is refused. */
  blocked: boolean;
  warn: boolean;
  models: Array<Pick<AiModelDef, 'id' | 'label' | 'role' | 'vision'>>;
  defaultModel: string;
  /** False when the server has neither an Anthropic nor a Meta key. */
  configured: boolean;
  /** Turning Dry run off is for ai_assistant.manage. */
  canLeaveDryRun: boolean;
}
