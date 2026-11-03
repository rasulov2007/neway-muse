import { afterEach, describe, expect, it } from 'vitest';
import {
  archiveTruckRecord,
  getTruck,
  globalSearch,
  invalidateRoster,
  listTrucks,
  restoreTruckRecord,
} from '@/demo';
import { resetRosterServer } from '@/test/roster-server';
import { loadFleetBundle } from './useFleet';

/**
 * An archived truck (owner, 2026-10-05) is off every list, picker and count of the fleet, and
 * still answers by id so its own page and old records naming it keep working.
 */
afterEach(() => {
  resetRosterServer();
  invalidateRoster();
});

async function archiveFirst() {
  const first = (await listTrucks({ pageSize: 1 })).data[0];
  if (!first) throw new Error('fixture has no trucks');
  const current = await getTruck(first.id);
  const archived = await archiveTruckRecord(
    first.id,
    'Test: left the fleet',
    current?.updatedAt ?? '',
  );
  return { first, archived };
}

describe('an archived truck', () => {
  it('leaves the trucks list, but is listed when archived trucks are asked for', async () => {
    const before = await listTrucks({ pageSize: 200 });
    const { first, archived } = await archiveFirst();
    expect(archived.status).toBe('archived');

    const after = await listTrucks({ pageSize: 200 });
    expect(after.total).toBe(before.total - 1);
    expect(after.data.some((t) => t.id === first.id)).toBe(false);

    const withArchived = await listTrucks({ pageSize: 200, includeArchived: true });
    expect(withArchived.data.some((t) => t.id === first.id)).toBe(true);
    const onlyArchived = await listTrucks({ pageSize: 200, status: 'archived' });
    expect(onlyArchived.data.map((t) => t.id)).toEqual([first.id]);
  });

  it('is still found by id, so its page and old records resolve', async () => {
    const { first } = await archiveFirst();
    expect((await getTruck(first.id))?.status).toBe('archived');
  });

  it('is not offered by global search', async () => {
    const { first } = await archiveFirst();
    const hits = await globalSearch(first.unitNumber);
    expect(hits.trucks.some((t) => t.id === first.id)).toBe(false);
  });

  it('is out of the fleet bundle lists and counts, but in its lookups and Archived list', async () => {
    const { first } = await archiveFirst();
    const bundle = await loadFleetBundle();
    expect(bundle.trucks.some((row) => row.truck.id === first.id)).toBe(false);
    expect(bundle.archivedTrucks.map((row) => row.truck.id)).toEqual([first.id]);
    expect(bundle.byTruckId.get(first.id)?.truck.status).toBe('archived');
    const findingIds = bundle.exceptions.items.flatMap((item) => item.ids);
    expect(findingIds).not.toContain(first.id);
  });

  it('comes back as available on restore', async () => {
    const { first } = await archiveFirst();
    const current = await getTruck(first.id);
    const restored = await restoreTruckRecord(first.id, current?.updatedAt ?? '');
    expect(restored.status).toBe('available');
    const list = await listTrucks({ pageSize: 200 });
    expect(list.data.some((t) => t.id === first.id)).toBe(true);
  });
});
