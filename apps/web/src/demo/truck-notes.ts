/**
 * Notes people keep on a unit.
 *
 * Not every fact about a truck is a repair: which trailer it pulls best, that the APU rattles,
 * who has the spare key. Those went nowhere before, so they lived in somebody's phone.
 *
 * Synchronous on purpose — a note is written and read in the same breath, and the array is
 * carried by the snapshot in `state-persist`, so it survives a refresh like every other write.
 */
import { demoData } from './data';
import type { TruckNote } from './types';

export function listTruckNotes(truckId: string): TruckNote[] {
  return demoData.truckNotes.filter((note) => note.truckId === truckId);
}

export function addTruckNote(input: {
  truckId: string;
  body: string;
  authorName: string;
}): TruckNote[] {
  const note: TruckNote = {
    id: `tnote_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    truckId: input.truckId,
    body: input.body.trim(),
    authorName: input.authorName,
    at: new Date().toISOString(),
  };
  demoData.truckNotes.unshift(note);
  return listTruckNotes(input.truckId);
}
