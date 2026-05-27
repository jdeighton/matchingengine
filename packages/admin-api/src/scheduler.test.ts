import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { InstrumentRegistry } from '@matchingengine/engine';
import type { InstrumentDefinition } from '@matchingengine/shared-types';
import { Scheduler } from './scheduler.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeInstrumentDef(overrides?: Partial<InstrumentDefinition>): InstrumentDefinition {
  return {
    symbol: 'ESZ4',
    name: 'E-mini S&P Dec 2024',
    tickSize: 0.25,
    contractSize: 50,
    currency: 'USD',
    expiryDate: new Date('2099-12-31'),
    ...overrides,
  };
}

// Fixed reference point: 08:00:00 UTC on a weekday.
const DAY_START = new Date('2024-01-15T08:00:00.000Z');
const OPEN_TIME  = '08:30';
const CLOSE_TIME = '15:00';
const MIN = 60_000;
const HOUR = 60 * MIN;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(DAY_START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens market at configured UTC openTime', () => {
    const registry = new InstrumentRegistry();
    registry.add(makeInstrumentDef());
    // starts Closed

    const scheduler = new Scheduler(registry);
    scheduler.setSchedule('ESZ4', OPEN_TIME, CLOSE_TIME);

    vi.advanceTimersByTime(30 * MIN);   // 08:00 → 08:30

    expect(registry.get('ESZ4')!.marketState).toBe('Open');
  });

  it('closes market at configured UTC closeTime', () => {
    const registry = new InstrumentRegistry();
    registry.add(makeInstrumentDef());
    registry.setMarketState('ESZ4', 'Open');

    const scheduler = new Scheduler(registry);
    scheduler.setSchedule('ESZ4', OPEN_TIME, CLOSE_TIME);

    vi.advanceTimersByTime(7 * HOUR);   // 08:00 → 15:00

    expect(registry.get('ESZ4')!.marketState).toBe('Closed');
  });

  it('cancelSchedule prevents both transitions from firing', () => {
    const registry = new InstrumentRegistry();
    registry.add(makeInstrumentDef());

    const scheduler = new Scheduler(registry);
    scheduler.setSchedule('ESZ4', OPEN_TIME, CLOSE_TIME);
    scheduler.cancelSchedule('ESZ4');

    vi.advanceTimersByTime(24 * HOUR);  // advance a full day — past both times

    expect(registry.get('ESZ4')!.marketState).toBe('Closed'); // unchanged
  });

  it('re-registers daily so open fires on the next day too', () => {
    const registry = new InstrumentRegistry();
    registry.add(makeInstrumentDef());

    const scheduler = new Scheduler(registry);
    scheduler.setSchedule('ESZ4', OPEN_TIME, CLOSE_TIME);

    // Day 1 open: 08:00 → 08:30 (+30 min)
    vi.advanceTimersByTime(30 * MIN);
    expect(registry.get('ESZ4')!.marketState).toBe('Open');

    // Day 1 close: 08:30 → 15:00 (+6.5 h)
    vi.advanceTimersByTime(6.5 * HOUR);
    expect(registry.get('ESZ4')!.marketState).toBe('Closed');

    // Day 2 open: 15:00 → next 08:30 (+17.5 h)
    vi.advanceTimersByTime(17.5 * HOUR);
    expect(registry.get('ESZ4')!.marketState).toBe('Open');
  });

  it('does not throw and stops re-registering when instrument is delisted without explicit cancel', () => {
    const registry = new InstrumentRegistry();
    registry.add(makeInstrumentDef());

    const scheduler = new Scheduler(registry);
    scheduler.setSchedule('ESZ4', OPEN_TIME, CLOSE_TIME);

    // Delist without calling cancelSchedule (simulate a bug or direct registry access).
    registry.delist('ESZ4');

    // Timer fires — setMarketState throws (instrument gone), no re-registration.
    expect(() => vi.advanceTimersByTime(30 * MIN)).not.toThrow();

    // A full extra day passes — no further timers should fire.
    expect(() => vi.advanceTimersByTime(24 * HOUR)).not.toThrow();
  });

  it('replaces existing schedule when setSchedule is called again', () => {
    const registry = new InstrumentRegistry();
    registry.add(makeInstrumentDef());

    const scheduler = new Scheduler(registry);
    // First schedule: open at 08:30
    scheduler.setSchedule('ESZ4', OPEN_TIME, CLOSE_TIME);
    // Override: open at 09:00 instead
    scheduler.setSchedule('ESZ4', '09:00', CLOSE_TIME);

    vi.advanceTimersByTime(30 * MIN); // → 08:30 — OLD timer cleared, should NOT fire
    expect(registry.get('ESZ4')!.marketState).toBe('Closed');

    vi.advanceTimersByTime(30 * MIN); // → 09:00 — NEW timer fires
    expect(registry.get('ESZ4')!.marketState).toBe('Open');
  });
});
