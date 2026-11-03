import type { ImportPlan, RowResult } from './plan';

/**
 * The import report (docs/pm-module/04-sheet-import.md §5): what a person reads before the real
 * run, and what the customer sees first. One line per row - imported, unchanged, skipped or
 * flagged, and why - plus the numbers the package names. Markdown for people, CSV for a sheet.
 */

const n = (v: number) => v.toLocaleString('en-US');

export function reportMarkdown(plan: ImportPlan, meta: { fileName: string; dryRun: boolean; importedAt: string; exportedAt: string | null; kind: string }): string {
  const s = plan.summary;
  const lines: string[] = [];
  lines.push(`# PM board import — ${meta.dryRun ? 'dry run' : 'applied'}`);
  lines.push('');
  lines.push(`File: \`${meta.fileName}\` (${meta.kind}) · run ${meta.importedAt} · export time ${meta.exportedAt ?? '**unknown — CURRENT readings are undated and every row shows No reading until a fresh one arrives**'}`);
  lines.push(`Date format detected: ${Object.entries(s.dateFormats).map(([k, v]) => `${k} ×${v}`).join(', ') || '—'}`);
  lines.push('');
  if (plan.parseErrors.length > 0) {
    lines.push('## Refused: the file did not parse');
    lines.push('');
    lines.push('Nothing is written until the whole file parses.');
    lines.push('');
    for (const e of plan.parseErrors) lines.push(`- line ${e.line}: ${e.errors.join('; ')}`);
    lines.push('');
  }
  lines.push('## Trucks');
  lines.push('');
  lines.push(`- rows in the file: ${s.rows}`);
  lines.push(`- ${meta.dryRun ? 'would import' : 'imported'}: ${s.imported} · unchanged (already on record): ${s.unchanged} · skipped: ${s.skipped}`);
  for (const [reason, count] of Object.entries(s.skippedBy)) lines.push(`  - skipped, ${reason}: ${count}`);
  lines.push(`- units created: ${s.unitsCreated} (never)`);
  lines.push('');
  lines.push('## Intervals');
  lines.push('');
  lines.push(`- with an interval: ${s.intervalDistribution.reduce((a, d) => a + d.count, 0)}`);
  lines.push(`- distribution: ${s.intervalDistribution.map((d) => `${n(d.intervalMiles)} ×${d.count}`).join(' · ') || '—'}`);
  lines.push('');
  lines.push('## Overdue at import');
  lines.push('');
  lines.push(`- ${s.overdue.count} of ${s.overdue.of} overdue · ${n(s.overdue.totalMilesOver)} mi past due in total${s.overdue.worst ? ` · worst ${n(s.overdue.worst.milesOver)} on #${s.overdue.worst.unit}` : ''}`);
  lines.push('- computed from the sheet\'s inputs (last PM + interval − current), not from its own derived columns');
  lines.push('');
  lines.push('## Data to fix');
  lines.push('');
  lines.push(`- rows with no cost: ${s.costMissing}`);
  lines.push(`- rows with no shop: ${s.shopMissing}`);
  lines.push(`- rows whose own arithmetic was stale: ${s.staleArithmetic}`);
  lines.push(`- lease rows (PM by the lessor): ${s.leaseRows}`);
  lines.push('');
  lines.push('## Shops');
  lines.push('');
  lines.push(`- matched existing vendors: ${s.vendorsMatched} · draft vendors ${meta.dryRun ? 'to create' : 'created'}: ${s.vendorsDrafted}`);
  for (const v of plan.vendors) {
    lines.push(`  - ${v.existingId ? 'matched' : 'draft'}${v.isOwnYard ? ', own yard' : ''}: **${v.name}** (${v.rows.length} row${v.rows.length === 1 ? '' : 's'})${v.spellings.length > 1 ? ` — merges ${v.spellings.length} spellings: ${v.spellings.map((x) => `"${x}"`).join(', ')}` : ''}`);
  }
  lines.push('');
  lines.push('## Rows');
  lines.push('');
  lines.push('| line | unit | group | outcome | interval | run | left | amount | flags | notes |');
  lines.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const r of plan.rows) {
    lines.push(
      `| ${r.line} | ${r.unit ?? '—'} | ${r.group ?? '—'} | ${r.outcome}${r.skipReason ? ` — ${r.skipReason}` : ''} | ${r.intervalMiles === null ? '—' : n(r.intervalMiles)} | ${r.recomputed ? n(r.recomputed.totalRunning) : '—'} | ${r.recomputed ? n(r.recomputed.milesLeft) : '—'} | ${r.amount === null ? '—' : r.amount.toFixed(2)} | ${r.flags.join(', ') || '—'} | ${r.notes.join('; ') || '—'} |`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

export function reportCsv(plan: ImportPlan): string {
  const quote = (v: string | number | null) => (v === null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const header = ['line', 'unit', 'group', 'outcome', 'skip_reason', 'interval_miles', 'total_running', 'miles_left', 'amount', 'flags', 'notes'];
  const rows = plan.rows.map((r: RowResult) =>
    [
      r.line,
      r.unit,
      r.group,
      r.outcome,
      r.skipReason,
      r.intervalMiles,
      r.recomputed?.totalRunning ?? null,
      r.recomputed?.milesLeft ?? null,
      r.amount,
      r.flags.join(' '),
      r.notes.join('; '),
    ]
      .map(quote)
      .join(','),
  );
  return [header.join(','), ...rows].join('\n') + '\n';
}
