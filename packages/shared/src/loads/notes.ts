import { z } from 'zod';
import type { NoteLike } from './model.js';

/**
 * A note on a load (P0.1).
 *
 * The author is the person signed in - taken from the session on the server, never from the
 * form - and the time is the server's. A note pinned stays at the top of the list until the same
 * or another person unpins it; nothing about a note is ever edited in place.
 */
export const AddLoadNoteSchema = z.object({
  kind: z.enum(['internal', 'broker', 'driver']).default('internal'),
  body: z.string().trim().min(1, 'Write the note first').max(4000),
  pinned: z.boolean().default(false),
  expectedUpdatedAt: z.string().min(1),
});
export type AddLoadNoteInput = z.infer<typeof AddLoadNoteSchema>;
export type AddLoadNoteRequest = z.input<typeof AddLoadNoteSchema>;

export const PinLoadNoteSchema = z.object({
  noteId: z.string().min(1),
  pinned: z.boolean(),
  expectedUpdatedAt: z.string().min(1),
});
export type PinLoadNoteInput = z.infer<typeof PinLoadNoteSchema>;

export interface NoteAuthor {
  id: string;
  name: string;
}

export function buildNote(
  input: Pick<AddLoadNoteInput, 'kind' | 'body' | 'pinned'>,
  author: NoteAuthor,
  now: string,
  id: string,
): NoteLike {
  return {
    id,
    kind: input.kind,
    body: input.body.trim(),
    authorId: author.id,
    authorName: author.name,
    at: now,
    pinned: input.pinned,
  };
}

/** Pinned first, newest first within each group: what the panel shows. */
export function orderNotes<T extends Pick<NoteLike, 'pinned' | 'at'>>(notes: readonly T[]): T[] {
  return [...notes].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return b.at.localeCompare(a.at);
  });
}

/** The first line of a note, for the timeline entry. */
export function noteSummary(body: string, max = 140): string {
  const line = body.trim().split(/\r?\n/)[0] ?? '';
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}
