import type { RateConfirmationExtract } from '@neway/shared';

export type Gold = Omit<RateConfirmationExtract, 'linehaulRate' | 'hazmat' | 'temperature' | 'notes' | 'warnings' | 'stops'> & {
  scanned?: boolean;
  stops: Array<Pick<RateConfirmationExtract['stops'][number], 'kind' | 'city' | 'state' | 'zip' | 'date' | 'time' | 'endTime'>>;
};

export const squash = (s: unknown) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Each checked field: [name, right?]. */
export function score(gold: Gold, got: RateConfirmationExtract): Array<[string, boolean, string]> {
  const out: Array<[string, boolean, string]> = [];
  const add = (name: string, ok: boolean, detail: unknown) => out.push([name, ok, ok ? '' : JSON.stringify(detail)]);
  const firstWord = squash(gold.brokerName?.split(/\s+/)[0]);
  add('broker', Boolean(firstWord) && squash(got.brokerName).includes(firstWord), got.brokerName);
  add('brokerMc', (gold.brokerMc ?? null) === (got.brokerMc ?? null), got.brokerMc);
  add('loadNumber', squash(gold.brokerLoadNumber) === squash(got.brokerLoadNumber), got.brokerLoadNumber);
  add('rate', gold.totalRate === got.totalRate, got.totalRate);
  add('weight', gold.weightLbs === null ? got.weightLbs === null : Math.abs((got.weightLbs ?? -9) - gold.weightLbs) <= 1, got.weightLbs);
  add('equipment', (gold.equipment ?? null) === (got.equipment ?? null), got.equipment);
  add('stopCount', gold.stops.length === got.stops.length, got.stops.length);
  gold.stops.forEach((g, i) => {
    const s = got.stops[i];
    add('stop.kind', s?.kind === g.kind, s?.kind);
    add('stop.city', squash(s?.city) === squash(g.city), s?.city);
    add('stop.state', (s?.state ?? null) === g.state, s?.state);
    add('stop.zip', (s?.zip ?? null) === g.zip, s?.zip);
    add('stop.date', (s?.date ?? null) === g.date, s?.date);
    add('stop.time', (s?.time ?? null) === g.time, s?.time);
    add('stop.endTime', (s?.endTime ?? null) === g.endTime, s?.endTime);
  });
  return out;
}

