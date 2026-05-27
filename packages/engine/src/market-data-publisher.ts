import type { OrderBookEvent, Snapshot, TradeEvent } from '@matchingengine/shared-types';
import type { InstrumentRegistry } from './instrument-registry.js';

export type MarketDataEvent = OrderBookEvent | TradeEvent;
export type EventHandler = (event: MarketDataEvent) => void;

export class MarketDataPublisher {
  /** symbol → Map<sessionId, handler> */
  private readonly subscriptions = new Map<string, Map<string, EventHandler>>();

  constructor(private readonly registry: InstrumentRegistry) {}

  subscribe(sessionId: string, symbol: string, handler: EventHandler): Snapshot {
    if (!this.subscriptions.has(symbol)) {
      this.subscriptions.set(symbol, new Map());
    }
    this.subscriptions.get(symbol)!.set(sessionId, handler);
    return this.registry.getSnapshot(symbol);
  }

  unsubscribe(sessionId: string, symbol: string): void {
    this.subscriptions.get(symbol)?.delete(sessionId);
  }

  disconnect(sessionId: string): void {
    for (const handlers of this.subscriptions.values()) {
      handlers.delete(sessionId);
    }
  }

  publish(symbol: string, event: MarketDataEvent): void {
    const handlers = this.subscriptions.get(symbol);
    if (!handlers) return;
    for (const handler of handlers.values()) {
      handler(event);
    }
  }
}
