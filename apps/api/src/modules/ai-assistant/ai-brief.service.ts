import { Inject, Injectable, Logger } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import type { Principal } from '../../common/auth/principal';
import { CLOCK, type Clock } from '../dashboard/clock';
import { StateService } from '../state/state.service';
import { AiAssistantService } from './ai-assistant.service';
import type { ActionContext } from './ai-actions/types';
import { eastern, plainBrief, type BriefIssue } from './insights/detect';
import { collectBrief, type BriefRun } from './insights/insight-tools';

/**
 * The Morning brief - NeWay AI's loop (hackathon A2, 2026-11-03).
 *
 * The server runs every read-only check the person may run (late loads, papers, route, fuel,
 * billing, hiring), ranks what it found urgent → warning → info, and asks the default AI model -
 * through the assistant's own client, budget and usage ledger - to write it up in a few lines.
 * The ranked issues are the facts; the model only words them. Without a model (no key, budget
 * used up) the brief is the ranked list itself.
 *
 * Kept per person, not per company: what a brief lists depends on what its reader may see, so
 * one person's brief is never shown to another. Stored in the company's app_state under
 * `srv-ai-briefs` (no policy in workspace/access.ts, so the browser's /state never serves it).
 * Each person keeps their latest brief only; it is a reading, not a business record.
 */

export const BRIEF_STATE_KEY = 'srv-ai-briefs';

export interface StoredBrief extends BriefRun {
  /** Markdown the model wrote (or the plain list without a model). */
  text: string;
  aiWritten: boolean;
  trigger: 'manual' | 'scheduled';
  requestedBy: string;
  /** Server-only: whose permissions a scheduled re-run reads with. Never sent to the browser. */
  membershipId?: string;
  userId: string;
}

export type BriefView = Omit<StoredBrief, 'membershipId'> & { generatedAtEastern: string | null };

/**
 * Room for the model's reasoning as well as the bullets: Muse Spark counts reasoning tokens in
 * max_tokens and spent all of 900 on it (finish "length", no text), so the brief fell back to the
 * plain list. Measured 2026-11-03: ~780 reasoning + ~200 text tokens for 23 issues.
 */
const BRIEF_MAX_TOKENS = 4000;

const BRIEF_SYSTEM = [
  'You are NeWay AI writing the Morning brief for a trucking company manager in NeWay TMS.',
  'You get JSON: issues already ranked urgent → warning → info, with counts and what was not included.',
  'Write at most 12 short Markdown bullet lines, most urgent first. Start each line with the level word in bold: **Urgent**, **Warning** or **Info**, then the unit / load / person and the one action to take.',
  'Group similar info items into one line. Never invent a fact, number, name or time that is not in the JSON. Times are US Eastern.',
  'Begin with one line: "**Morning brief · <date>**" and a one-sentence summary with the counts. If there are no issues, say nothing needs attention.',
].join('\n');

@Injectable()
export class AiBriefService {
  private readonly logger = new Logger(AiBriefService.name);
  private readonly ctx: ActionContext = { get: (type) => this.moduleRef.get(type as never, { strict: false }) };

  constructor(
    private readonly ai: AiAssistantService,
    private readonly state: StateService,
    private readonly moduleRef: ModuleRef,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Runs the checks, has the model write them up, stores the result as the person's latest. */
  async run(principal: Principal, trigger: 'manual' | 'scheduled' = 'manual'): Promise<BriefView> {
    const now = this.clock();
    const run = await collectBrief(this.ctx, principal, now);
    const todayLabel = new Date(`${run.today}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric', timeZone: 'UTC' });
    const facts = {
      date: todayLabel,
      now: eastern(run.generatedAt),
      counts: run.counts,
      issues: run.issues.map((i: BriefIssue) => ({ level: i.level, area: i.area, title: i.title, detail: i.detail })),
      notIncluded: run.skipped,
    };
    const written = await this.ai.complete(principal, { system: BRIEF_SYSTEM, messages: [{ role: 'user', text: JSON.stringify(facts) }], maxTokens: BRIEF_MAX_TOKENS });
    const brief: StoredBrief = {
      ...run,
      text: written ?? plainBrief(run.issues, todayLabel),
      aiWritten: Boolean(written),
      trigger,
      requestedBy: principal.userName ?? principal.userId,
      userId: principal.userId,
      ...(principal.membershipId ? { membershipId: principal.membershipId } : {}),
    };
    await this.save(principal.companyId, principal.userId, brief);
    this.logger.log({ companyId: principal.companyId, userId: principal.userId, trigger, issues: run.issues.length, aiWritten: brief.aiWritten }, 'Morning brief built');
    return view(brief);
  }

  /** The person's latest brief in this company, or null when they never ran one. */
  async latest(principal: Principal): Promise<BriefView | null> {
    const all = await this.read(principal.companyId);
    const mine = all.value[principal.userId];
    return mine ? view(mine) : null;
  }

  /** Everyone in the company who has a brief, for the scheduled re-run. */
  async holders(companyId: string): Promise<Array<{ userId: string; membershipId: string }>> {
    const all = await this.read(companyId);
    return Object.values(all.value)
      .filter((b): b is StoredBrief & { membershipId: string } => Boolean(b.membershipId))
      .map((b) => ({ userId: b.userId, membershipId: b.membershipId }));
  }

  private async read(companyId: string): Promise<{ value: Record<string, StoredBrief>; updatedAt: string | undefined }> {
    const row = await this.state.getFor(companyId, BRIEF_STATE_KEY);
    if (!row) return { value: {}, updatedAt: undefined };
    try {
      const parsed = JSON.parse(row.value) as unknown;
      return { value: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, StoredBrief>) : {}, updatedAt: row.updatedAt };
    } catch {
      return { value: {}, updatedAt: row.updatedAt };
    }
  }

  /** One person's entry replaced; a write that raced another is re-read and retried, never lost. */
  private async save(companyId: string, userId: string, brief: StoredBrief): Promise<void> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = await this.read(companyId);
      const next = { ...current.value, [userId]: brief };
      const ok = await this.state.putFor(companyId, BRIEF_STATE_KEY, JSON.stringify(next), current.updatedAt ?? new Date(0).toISOString());
      if (ok !== null) return;
    }
    throw new Error('The brief could not be saved: it kept changing underneath. Try again.');
  }
}

function view(b: StoredBrief): BriefView {
  const { membershipId: _hidden, ...rest } = b;
  void _hidden;
  return { ...rest, generatedAtEastern: eastern(b.generatedAt) };
}
