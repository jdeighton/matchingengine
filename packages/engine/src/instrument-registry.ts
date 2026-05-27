import type {
  Instrument,
  InstrumentDefinition,
  MarketState,
  Order,
  OrderStateUpdate,
  Snapshot,
  SubmitResult,
} from '@matchingengine/shared-types';
import { OrderBook } from './order-book.js';

type MarketStateChangedHandler = (symbol: string, state: MarketState) => void;
type OrdersCancelledOnCloseHandler = (symbol: string, updates: OrderStateUpdate[]) => void;

interface InstrumentEntry {
  instrument: Instrument;
  orderBook: OrderBook;
  expiryTimer?: ReturnType<typeof setTimeout>;
}

/** Valid Market State transitions. */
const VALID_TRANSITIONS: Record<MarketState, MarketState[]> = {
  Closed: ['Open'],
  Open: ['Closed', 'Halted'],
  Halted: ['Open', 'Closed'],
};

export class InstrumentRegistry {
  private readonly entries = new Map<string, InstrumentEntry>();
  private readonly marketStateChangedHandlers: MarketStateChangedHandler[] = [];
  private readonly ordersCancelledOnCloseHandlers: OrdersCancelledOnCloseHandler[] = [];

  // ─── Lifecycle ──────────────────────────────────────────────────────────

  add(def: InstrumentDefinition): void {
    if (this.entries.has(def.symbol)) {
      throw new Error(`Instrument already exists: ${def.symbol}`);
    }
    const instrument: Instrument = { ...def, marketState: 'Closed' };
    const orderBook = new OrderBook(def.symbol);
    const expiryTimer = this.scheduleExpiry(def.symbol, def.expiryDate);
    this.entries.set(def.symbol, { instrument, orderBook, expiryTimer });
  }

  delist(symbol: string): void {
    const entry = this.requireEntry(symbol);
    if (entry.expiryTimer !== undefined) clearTimeout(entry.expiryTimer);
    this.entries.delete(symbol);
  }

  get(symbol: string): Instrument | undefined {
    return this.entries.get(symbol)?.instrument;
  }

  list(): Instrument[] {
    return [...this.entries.values()].map((e) => e.instrument);
  }

  // ─── Market State ────────────────────────────────────────────────────────

  setMarketState(symbol: string, newState: MarketState): void {
    const entry = this.requireEntry(symbol);
    const current = entry.instrument.marketState;
    const allowed = VALID_TRANSITIONS[current];

    if (!allowed.includes(newState)) {
      throw new Error(
        `Invalid Market State transition for ${symbol}: ${current} → ${newState}`,
      );
    }

    entry.instrument.marketState = newState;
    this.marketStateChangedHandlers.forEach((h) => h(symbol, newState));

    if (newState === 'Closed') {
      this.cancelAllResting(symbol, entry);
    }
  }

  // ─── Order submission ────────────────────────────────────────────────────

  submit(order: Order): SubmitResult {
    const entry = this.requireEntry(order.symbol);
    const state = entry.instrument.marketState;

    if (state === 'Closed' || state === 'Halted') {
      const update: OrderStateUpdate = {
        orderId: order.id,
        state: 'Rejected',
        filledQuantity: 0,
        cancelReason: undefined,
      };
      return { trades: [], updates: [update] };
    }

    const result = entry.orderBook.submit(order);
    return result;
  }

  getSnapshot(symbol: string): Snapshot {
    const entry = this.requireEntry(symbol);
    return { symbol, orders: entry.orderBook.snapshot() };
  }

  cancel(orderId: string, symbol: string): OrderStateUpdate {
    const entry = this.requireEntry(symbol);
    return entry.orderBook.cancel(orderId);
  }

  // ─── Event registration ──────────────────────────────────────────────────

  onMarketStateChanged(handler: MarketStateChangedHandler): void {
    this.marketStateChangedHandlers.push(handler);
  }

  onOrdersCancelledOnClose(handler: OrdersCancelledOnCloseHandler): void {
    this.ordersCancelledOnCloseHandlers.push(handler);
  }

  // ─── Private helpers ─────────────────────────────────────────────────────

  private requireEntry(symbol: string): InstrumentEntry {
    const entry = this.entries.get(symbol);
    if (!entry) throw new Error(`Instrument not found: ${symbol}`);
    return entry;
  }

  private cancelAllResting(symbol: string, entry: InstrumentEntry): void {
    const resting = entry.orderBook.snapshot();
    if (resting.length === 0) return;

    const updates: OrderStateUpdate[] = resting.map((order) =>
      entry.orderBook.cancel(order.id),
    );

    this.ordersCancelledOnCloseHandlers.forEach((h) => h(symbol, updates));
  }

  private scheduleExpiry(symbol: string, expiryDate: Date): ReturnType<typeof setTimeout> | undefined {
    const delay = expiryDate.getTime() - Date.now();
    if (delay <= 0) return undefined;

    // Node's setTimeout only accepts 32-bit signed integers (~24.8 days max).
    // For longer delays, re-schedule recursively until close enough to fire.
    const MAX_DELAY = 2_147_483_647;
    if (delay > MAX_DELAY) {
      return setTimeout(() => {
        const entry = this.entries.get(symbol);
        if (entry) entry.expiryTimer = this.scheduleExpiry(symbol, expiryDate);
      }, MAX_DELAY);
    }

    return setTimeout(() => {
      const entry = this.entries.get(symbol);
      if (entry && entry.instrument.marketState !== 'Closed') {
        this.setMarketState(symbol, 'Closed');
      }
    }, delay);
  }
}
