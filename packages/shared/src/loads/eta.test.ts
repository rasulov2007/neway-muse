import { describe, expect, it } from 'vitest';
import { LOADS_CONFIG, updateIntervalMinutes } from './config.js';
import { classifyDelivery, deadlineOf, projectEta, updateDue } from './eta.js';

const NOW = '2026-09-25T12:00:00.000Z';

describe('the projected ETA', () => {
  it('is now plus the miles at the configured speed', () => {
    // 94 miles at 47 mph is two hours.
    expect(projectEta({ nowIso: NOW, remainingMiles: 94 })).toBe('2026-09-25T14:00:00.000Z');
  });

  it('is nothing when the miles are unknown, rather than a guess', () => {
    expect(projectEta({ nowIso: NOW, remainingMiles: null })).toBeNull();
  });
});

describe('the deadline', () => {
  it('is the window end for a window and the time itself for a fixed appointment', () => {
    expect(deadlineOf({ appointmentStartAt: '2026-09-25T13:00:00Z', appointmentEndAt: '2026-09-25T15:00:00Z' })).toBe(Date.parse('2026-09-25T15:00:00Z'));
    expect(deadlineOf({ appointmentStartAt: '2026-09-25T13:00:00Z', appointmentEndAt: '2026-09-25T15:00:00Z', appointmentNoWindow: true })).toBe(Date.parse('2026-09-25T13:00:00Z'));
  });
});

describe('the four words', () => {
  const stop = { appointmentStartAt: '2026-09-25T14:00:00Z', appointmentEndAt: '2026-09-25T16:00:00Z', arrivedAt: null };

  it('on time: the ETA clears the deadline by more than the buffer', () => {
    const v = classifyDelivery({ ...stop, nowIso: NOW, etaAt: '2026-09-25T15:00:00Z', tracking: 'live' });
    expect(v.state).toBe('on_time');
  });

  it('at risk: the ETA lands inside the buffer before the deadline', () => {
    const v = classifyDelivery({ ...stop, nowIso: NOW, etaAt: '2026-09-25T15:45:00Z', tracking: 'live' });
    expect(v.state).toBe('at_risk');
    expect(v.minutesLate).toBe(-15);
  });

  it('late: the ETA is past the deadline', () => {
    const v = classifyDelivery({ ...stop, nowIso: NOW, etaAt: '2026-09-25T16:20:00Z', tracking: 'recent' });
    expect(v.state).toBe('late');
    expect(v.minutesLate).toBe(20);
  });

  it('late: the deadline has passed and nobody recorded an arrival, whatever the feed says', () => {
    const v = classifyDelivery({ ...stop, nowIso: '2026-09-25T17:00:00Z', etaAt: null, tracking: 'offline' });
    expect(v.state).toBe('late');
  });

  it('no update: a stale position is never on time', () => {
    for (const tracking of ['stale', 'offline', 'none'] as const) {
      const v = classifyDelivery({ ...stop, nowIso: NOW, etaAt: '2026-09-25T15:00:00Z', tracking });
      expect(v.state).toBe('no_update');
    }
  });

  it('an arrival on record settles it, ETA or no ETA', () => {
    const early = classifyDelivery({ ...stop, arrivedAt: '2026-09-25T15:30:00Z', nowIso: NOW, etaAt: null, tracking: 'none' });
    expect(early.state).toBe('on_time');
    const lateArrival = classifyDelivery({ ...stop, arrivedAt: '2026-09-25T16:30:00Z', nowIso: NOW, etaAt: null, tracking: 'none' });
    expect(lateArrival.state).toBe('late');
    expect(lateArrival.minutesLate).toBe(30);
  });
});

describe('how often a load needs an update', () => {
  it('tightens as the appointment nears', () => {
    expect(updateIntervalMinutes(30)).toBe(15);
    expect(updateIntervalMinutes(120)).toBe(30);
    expect(updateIntervalMinutes(6 * 60)).toBe(60);
    expect(updateIntervalMinutes(3 * 24 * 60)).toBe(LOADS_CONFIG.updateCadence[LOADS_CONFIG.updateCadence.length - 1]!.everyMinutes);
  });

  it('says a load is due when its last update is older than the interval', () => {
    const due = updateDue({ nowIso: NOW, appointmentAt: '2026-09-25T12:40:00Z', lastUpdateAt: '2026-09-25T11:30:00Z' });
    expect(due.everyMinutes).toBe(15);
    expect(due.sinceMinutes).toBe(30);
    expect(due.due).toBe(true);
    const fine = updateDue({ nowIso: NOW, appointmentAt: '2026-09-25T12:40:00Z', lastUpdateAt: '2026-09-25T11:50:00Z' });
    expect(fine.due).toBe(false);
  });

  it('is due when there has never been an update', () => {
    expect(updateDue({ nowIso: NOW, appointmentAt: null, lastUpdateAt: null }).due).toBe(true);
  });
});
