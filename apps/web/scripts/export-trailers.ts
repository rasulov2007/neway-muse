/**
 * One-time export of the trailer roster into a seed file, for the compliance seed.
 *
 * Trailers are not yet persisted (there is no `trailers` table), but their qualification items
 * are: the Safety pages evaluate every trailer against the catalog, so the items have to exist
 * server-side. The four fields the compliance seed reads are carried across with the original ids,
 * so `trl_…` references resolve unchanged when trailers themselves move into PostgreSQL.
 *
 * Run from the repo root:  npx tsx apps/web/scripts/export-trailers.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateDemoData } from '../src/demo/data';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', '..', 'api', 'src', 'database', 'seed', 'trailers.seed.ts');

const trailers = generateDemoData().trailers.map((t) => ({
  id: t.id,
  unitNumber: t.unitNumber,
  status: t.status,
  nextInspectionDate: t.nextInspectionDate,
}));

const banner = [
  '// GENERATED FILE - do not edit by hand.',
  '// Produced by apps/web/scripts/export-trailers.ts from the pinned dataset.',
  '// The trailer fields the compliance seed reads; trailers are not otherwise persisted yet.',
  '',
  'export interface TrailerSeed {',
  '  id: string;',
  '  unitNumber: string;',
  '  status: string;',
  '  nextInspectionDate: string;',
  '}',
  '',
  'export const TRAILER_SEED: TrailerSeed[] = ',
].join('\n');
writeFileSync(out, `${banner}${JSON.stringify(trailers, null, 2)};\n`, 'utf8');
console.log(`wrote ${trailers.length} trailers to ${out}`);
