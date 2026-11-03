import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import {
  buildActionQueue,
  evaluateEntity,
  requirementsFor,
  summarizeCompliance,
  type ComplianceAction,
  type ComplianceScope,
  type ComplianceSummary,
  type EntityCompliance,
  type QualificationItem,
  type QualificationRequirement,
} from '@neway/shared';
import {
  DEMO_TODAY,
  listDrivers,
  listTrailers,
  listTrucks,
  type Driver,
  type Trailer,
  type Truck,
} from '@/demo';
import { listComplianceRequirements, listQualificationItems } from './compliance-api';
import { entityKey } from './compliance-ui';

/** Big enough to cover the demo fleet in one request; the real API pages server-side. */
const ALL = 10_000;

/** Every row of a paged list, page by page, in one result. */
async function everyPage<T>(read: (page: number) => Promise<{ data: T[]; total: number }>): Promise<{ data: T[]; total: number }> {
  const first = await read(1);
  const rows = [...first.data];
  for (let page = 2; rows.length < first.total && page <= 100; page += 1) rows.push(...(await read(page)).data);
  return { data: rows, total: first.total };
}

export interface ComplianceBundle {
  today: string;
  requirements: QualificationRequirement[];
  items: QualificationItem[];
  drivers: Driver[];
  trucks: Truck[];
  trailers: Trailer[];
  /** Every driver, unit and trailer that must be compliant, evaluated as of `today`. */
  entities: EntityCompliance[];
  byKey: Map<string, EntityCompliance>;
  summary: ComplianceSummary;
  byScope: Record<ComplianceScope, ComplianceSummary>;
  actions: ComplianceAction[];
}

export const COMPLIANCE_QUERY_KEY = ['compliance', 'bundle'] as const;

/**
 * Loads the catalog, the items and the entities they belong to, then runs the shared engine over
 * all of it once. Every page and drawer reads this one bundle, so a driver's status is the same
 * number everywhere and the pages never disagree with each other.
 *
 * Retired equipment and terminated drivers are left out: they have nothing to comply with.
 */
export async function loadComplianceBundle(): Promise<ComplianceBundle> {
  /*
   * The qualification file is readable only by somebody holding `compliance.view`, and Operations
   * reuses this bundle to show which drivers are held. A dispatcher does not hold that permission,
   * so those two calls are allowed to be REFUSED: without them there are no holds to report, which
   * is the honest answer for somebody who may not see the file. Letting the refusal propagate took
   * the loads list, tracking, drivers, customers and brokers down with it - five pages blank
   * because one panel was none of that person's business.
   *
   * The roster reads are not optional: a page cannot draw a fleet it could not load, and an
   * unreachable server must not look like an empty one.
   */
  const [requirementsResult, itemsResult] = await Promise.allSettled([
    listComplianceRequirements(),
    listQualificationItems(),
  ]);
  // Every page: a list reads at most 200 rows at a time, and a roster past 200 drivers (the local
  // database is; a growing carrier will be) must not lose its newest hires from the bundle.
  const [drivers, trucks, trailers] = await Promise.all([
    everyPage((page) => listDrivers({ page, pageSize: ALL, includeArchived: true })),
    everyPage((page) => listTrucks({ page, pageSize: ALL })),
    everyPage((page) => listTrailers({ page, pageSize: ALL })),
  ]);
  const forbidden = (result: PromiseSettledResult<unknown>) =>
    result.status === 'rejected' &&
    [401, 403].includes((result.reason as { status?: number } | null)?.status ?? 0);
  if (requirementsResult.status === 'rejected' && !forbidden(requirementsResult)) {
    throw requirementsResult.reason;
  }
  if (itemsResult.status === 'rejected' && !forbidden(itemsResult)) {
    throw itemsResult.reason;
  }
  const requirements = requirementsResult.status === 'fulfilled' ? requirementsResult.value : [];
  const items = itemsResult.status === 'fulfilled' ? itemsResult.value : [];
  const today = DEMO_TODAY;
  const options = { today };

  const itemsByEntity = new Map<string, QualificationItem[]>();
  for (const item of items) {
    const key = entityKey(item.scope, item.entityId);
    const bucket = itemsByEntity.get(key);
    if (bucket) bucket.push(item);
    else itemsByEntity.set(key, [item]);
  }
  const itemsFor = (scope: ComplianceScope, id: string) =>
    itemsByEntity.get(entityKey(scope, id)) ?? [];

  const driverRules = requirementsFor('driver', requirements);
  const truckRules = requirementsFor('truck', requirements);
  const trailerRules = requirementsFor('trailer', requirements);

  // An archived driver (owner, 2026-10-02) has nothing to comply with, like a terminated one.
  const activeDrivers = drivers.data.filter((d) => d.status !== 'terminated' && !d.archivedAt);
  const activeTrucks = trucks.data.filter((t) => t.status !== 'sold');
  const activeTrailers = trailers.data.filter((t) => t.status !== 'sold');

  const entities: EntityCompliance[] = [
    ...activeDrivers.map((d) =>
      evaluateEntity(
        { scope: 'driver', id: d.id, label: d.name },
        driverRules,
        itemsFor('driver', d.id),
        options,
      ),
    ),
    ...activeTrucks.map((t) =>
      evaluateEntity(
        { scope: 'truck', id: t.id, label: `Unit ${t.unitNumber}` },
        truckRules,
        itemsFor('truck', t.id),
        options,
      ),
    ),
    ...activeTrailers.map((t) =>
      evaluateEntity(
        { scope: 'trailer', id: t.id, label: `Trailer ${t.unitNumber}` },
        trailerRules,
        itemsFor('trailer', t.id),
        options,
      ),
    ),
  ];

  const byKey = new Map(entities.map((e) => [entityKey(e.scope, e.entityId), e]));
  const ofScope = (scope: ComplianceScope) => entities.filter((e) => e.scope === scope);

  return {
    today,
    requirements,
    items,
    drivers: drivers.data,
    trucks: trucks.data,
    trailers: trailers.data,
    entities,
    byKey,
    summary: summarizeCompliance(entities),
    byScope: {
      driver: summarizeCompliance(ofScope('driver')),
      truck: summarizeCompliance(ofScope('truck')),
      trailer: summarizeCompliance(ofScope('trailer')),
      company: summarizeCompliance(ofScope('company')),
    },
    actions: buildActionQueue(entities),
  };
}

export function useCompliance(): UseQueryResult<ComplianceBundle> {
  return useQuery({ queryKey: COMPLIANCE_QUERY_KEY, queryFn: loadComplianceBundle });
}

/** Everything a compliance mutation can change. One call keeps every safety view consistent. */
export function useInvalidateCompliance(): () => Promise<void> {
  const queryClient = useQueryClient();
  return async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['compliance'] }),
      queryClient.invalidateQueries({ queryKey: ['consents'] }),
      queryClient.invalidateQueries({ queryKey: ['verification'] }),
      queryClient.invalidateQueries({ queryKey: ['compliance-documents'] }),
      queryClient.invalidateQueries({ queryKey: ['compliance-audit'] }),
    ]);
  };
}
