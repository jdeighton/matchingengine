import type { InstrumentRegistry } from '@matchingengine/engine';
import type { MarketState } from '@matchingengine/shared-types';

type Timer = ReturnType<typeof setTimeout>;

interface SymbolTimers {
  open?: Timer;
  close?: Timer;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Returns the number of milliseconds until the next UTC occurrence of HH:MM.
 * If that time has already passed today, returns the delay until tomorrow's occurrence.
 */
function msUntilUtc(hhMM: string): number {
  const [hourStr, minuteStr] = hhMM.split(':');
  const hours   = parseInt(hourStr!,   10);
  const minutes = parseInt(minuteStr!, 10);

  const now = Date.now();
  const d   = new Date(now);

  const target = new Date(Date.UTC(
    d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(),
    hours, minutes, 0, 0,
  ));

  // If the target is now or already in the past, move to the next calendar day.
  if (target.getTime() <= now) {
    target.setUTCDate(target.getUTCDate() + 1);
  }

  return target.getTime() - now;
}

// ─── Scheduler ────────────────────────────────────────────────────────────────

/**
 * Fires timed Market State transitions based on per-Instrument HH:MM schedules.
 * Uses UTC times throughout.
 *
 * Usage:
 *   const scheduler = new Scheduler(registry);
 *   scheduler.setSchedule('ESZ4', '08:30', '15:00');
 *   // ... when instrument is delisted:
 *   scheduler.cancelSchedule('ESZ4');
 */
export class Scheduler {
  private readonly timers = new Map<string, SymbolTimers>();

  constructor(private readonly registry: InstrumentRegistry) {}

  /**
   * Register (or replace) the daily open/close schedule for a symbol.
   * Any previously registered timers for the symbol are cancelled first.
   */
  setSchedule(symbol: string, openTime: string, closeTime: string): void {
    this.cancelSchedule(symbol);
    this.scheduleNext(symbol, openTime,  'Open');
    this.scheduleNext(symbol, closeTime, 'Closed');
  }

  /**
   * Cancel all pending timers for a symbol.  Call this when delisting.
   */
  cancelSchedule(symbol: string): void {
    const entry = this.timers.get(symbol);
    if (!entry) return;
    if (entry.open  !== undefined) clearTimeout(entry.open);
    if (entry.close !== undefined) clearTimeout(entry.close);
    this.timers.delete(symbol);
  }

  // ─── Private ────────────────────────────────────────────────────────────────

  private scheduleNext(symbol: string, hhMM: string, targetState: MarketState): void {
    const delay = msUntilUtc(hhMM);
    const type  = targetState === 'Open' ? 'open' : 'close';

    const handle = setTimeout(() => {
      // Fire the transition.
      try {
        this.registry.setMarketState(symbol, targetState);
      } catch {
        // Instrument delisted or transition already in target state — ignore.
      }

      // Re-register for the next day's occurrence, but only if:
      //   (a) the timer was not explicitly cancelled, AND
      //   (b) the instrument still exists in the registry
      if (this.timers.has(symbol) && this.registry.get(symbol) !== undefined) {
        this.scheduleNext(symbol, hhMM, targetState);
      }
    }, delay);

    const entry = this.timers.get(symbol) ?? {};
    entry[type] = handle;
    this.timers.set(symbol, entry);
  }
}
