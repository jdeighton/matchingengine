import { describe, it, expect, vi } from 'vitest';
import { MarketDataPublisher, type MarketDataEvent } from './market-data-publisher.js';
import { InstrumentRegistry } from './instrument-registry.js';
import { OrderManager } from './order-manager.js';
import type { InstrumentDefinition, NewOrder, OrderBookEvent, TradeEvent } from '@matchingengine/shared-types';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeInstrumentDef(overrides?: Partial<InstrumentDefinition>): InstrumentDefinition {
  return {
    symbol: 'CLM26',
    name: 'Crude Light March 2026',
    tickSize: 0.25,
    contractSize: 1000,
    currency: 'USD',
    expiryDate: new Date('2099-12-31'),
    ...overrides,
  };
}

function makeNewOrder(overrides?: Partial<NewOrder>): NewOrder {
  return {
    symbol: 'CLM26',
    side: 'Buy',
    type: 'Limit',
    quantity: 10,
    price: 100.25,
    account: 'ACC1',
    trader: 'TDR1',
    ...overrides,
  };
}

function makeIdGen(): () => string {
  let n = 0;
  return () => `O${++n}`;
}

/** Build a registry with CLM26 open and optionally a second instrument. */
function makeRegistry(extraSymbol?: string): InstrumentRegistry {
  const registry = new InstrumentRegistry();
  registry.add(makeInstrumentDef({ symbol: 'CLM26' }));
  registry.setMarketState('CLM26', 'Open');
  if (extraSymbol) {
    registry.add(makeInstrumentDef({ symbol: extraSymbol }));
    registry.setMarketState(extraSymbol, 'Open');
  }
  return registry;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('MarketDataPublisher', () => {
  describe('subscribe', () => {
    it('returns the current Order Book Snapshot for the requested Symbol', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());
      const publisher = new MarketDataPublisher(registry);

      manager.place(makeNewOrder({ side: 'Buy', price: 100.25 }), 'SESSION-A');

      const snapshot = publisher.subscribe('SESSION-A', 'CLM26', vi.fn());

      expect(snapshot.symbol).toBe('CLM26');
      expect(snapshot.orders).toHaveLength(1);
      expect(snapshot.orders[0].price).toBe(100.25);
    });

    it('returns an empty snapshot when the Order Book has no resting orders', () => {
      const registry = makeRegistry();
      const publisher = new MarketDataPublisher(registry);

      const snapshot = publisher.subscribe('SESSION-A', 'CLM26', vi.fn());

      expect(snapshot.orders).toHaveLength(0);
    });
  });

  describe('publish — fan-out', () => {
    it('delivers a published event to a subscribed session', () => {
      const registry = makeRegistry();
      const publisher = new MarketDataPublisher(registry);
      const handler = vi.fn();
      publisher.subscribe('SESSION-A', 'CLM26', handler);

      const event: OrderBookEvent = {
        type: 'OrderAdded',
        order: {
          id: 'O1', symbol: 'CLM26', side: 'Buy', type: 'Limit',
          quantity: 10, price: 100.25, account: 'ACC1', trader: 'TDR1',
          state: 'New', filledQuantity: 0, timestamp: 1000,
        },
      };
      publisher.publish('CLM26', event);

      expect(handler).toHaveBeenCalledOnce();
      expect(handler).toHaveBeenCalledWith(event);
    });

    it('does not deliver events to sessions not subscribed to that Symbol', () => {
      const registry = makeRegistry();
      const publisher = new MarketDataPublisher(registry);
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      publisher.subscribe('SESSION-A', 'CLM26', handlerA);
      publisher.subscribe('SESSION-B', 'CLM26', handlerB);

      // Only publish to CLM26 — both should receive it
      const event: OrderBookEvent = {
        type: 'OrderAdded',
        order: {
          id: 'O1', symbol: 'CLM26', side: 'Buy', type: 'Limit',
          quantity: 10, price: 100.25, account: 'ACC1', trader: 'TDR1',
          state: 'New', filledQuantity: 0, timestamp: 1000,
        },
      };
      publisher.publish('CLM26', event);

      expect(handlerA).toHaveBeenCalledOnce();
      expect(handlerB).toHaveBeenCalledOnce();
    });

    it('does not deliver CLM26 events to a session subscribed only to a different symbol', () => {
      const registry = makeRegistry('CLZ26');
      const publisher = new MarketDataPublisher(registry);
      const clm26Handler = vi.fn();
      const clz26Handler = vi.fn();
      publisher.subscribe('SESSION-A', 'CLM26', clm26Handler);
      publisher.subscribe('SESSION-B', 'CLZ26', clz26Handler);

      const event: OrderBookEvent = {
        type: 'OrderAdded',
        order: {
          id: 'O1', symbol: 'CLM26', side: 'Buy', type: 'Limit',
          quantity: 10, price: 100.25, account: 'ACC1', trader: 'TDR1',
          state: 'New', filledQuantity: 0, timestamp: 1000,
        },
      };
      publisher.publish('CLM26', event);

      expect(clm26Handler).toHaveBeenCalledOnce();
      expect(clz26Handler).not.toHaveBeenCalled();
    });

    it('delivers TradeEvents to all sessions subscribed to that Symbol', () => {
      const registry = makeRegistry();
      const publisher = new MarketDataPublisher(registry);
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      publisher.subscribe('SESSION-A', 'CLM26', handlerA);
      publisher.subscribe('SESSION-B', 'CLM26', handlerB);

      const tradeEvent: TradeEvent = {
        trade: { symbol: 'CLM26', price: 100.25, quantity: 5, aggressingOrderId: 'O2', restingOrderId: 'O1' },
      };
      publisher.publish('CLM26', tradeEvent);

      expect(handlerA).toHaveBeenCalledWith(tradeEvent);
      expect(handlerB).toHaveBeenCalledWith(tradeEvent);
    });
  });

  describe('multi-instrument subscriptions', () => {
    it('a session subscribed to two symbols receives events for each independently', () => {
      const registry = makeRegistry('CLZ26');
      const publisher = new MarketDataPublisher(registry);
      const clm26Events: MarketDataEvent[] = [];
      const clz26Events: MarketDataEvent[] = [];

      publisher.subscribe('SESSION-A', 'CLM26', (e) => clm26Events.push(e));
      publisher.subscribe('SESSION-A', 'CLZ26', (e) => clz26Events.push(e));

      const clm26Event: OrderBookEvent = {
        type: 'OrderAdded',
        order: {
          id: 'O1', symbol: 'CLM26', side: 'Buy', type: 'Limit',
          quantity: 10, price: 100.25, account: 'ACC1', trader: 'TDR1',
          state: 'New', filledQuantity: 0, timestamp: 1000,
        },
      };
      const clz26Event: OrderBookEvent = {
        type: 'OrderAdded',
        order: {
          id: 'O2', symbol: 'CLZ26', side: 'Sell', type: 'Limit',
          quantity: 5, price: 101.00, account: 'ACC1', trader: 'TDR1',
          state: 'New', filledQuantity: 0, timestamp: 1000,
        },
      };

      publisher.publish('CLM26', clm26Event);
      publisher.publish('CLZ26', clz26Event);

      expect(clm26Events).toHaveLength(1);
      expect(clz26Events).toHaveLength(1);
    });
  });

  describe('unsubscribe', () => {
    it('stops delivery of events for that Symbol after unsubscribing', () => {
      const registry = makeRegistry();
      const publisher = new MarketDataPublisher(registry);
      const handler = vi.fn();
      publisher.subscribe('SESSION-A', 'CLM26', handler);

      publisher.unsubscribe('SESSION-A', 'CLM26');

      const event: OrderBookEvent = {
        type: 'OrderAdded',
        order: {
          id: 'O1', symbol: 'CLM26', side: 'Buy', type: 'Limit',
          quantity: 10, price: 100.25, account: 'ACC1', trader: 'TDR1',
          state: 'New', filledQuantity: 0, timestamp: 1000,
        },
      };
      publisher.publish('CLM26', event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('unsubscribing from one symbol does not affect subscription to another', () => {
      const registry = makeRegistry('CLZ26');
      const publisher = new MarketDataPublisher(registry);
      const handler = vi.fn();
      publisher.subscribe('SESSION-A', 'CLM26', handler);
      publisher.subscribe('SESSION-A', 'CLZ26', handler);

      publisher.unsubscribe('SESSION-A', 'CLM26');

      const clz26Event: OrderBookEvent = {
        type: 'OrderAdded',
        order: {
          id: 'O1', symbol: 'CLZ26', side: 'Buy', type: 'Limit',
          quantity: 5, price: 100.25, account: 'ACC1', trader: 'TDR1',
          state: 'New', filledQuantity: 0, timestamp: 1000,
        },
      };
      publisher.publish('CLZ26', clz26Event);

      expect(handler).toHaveBeenCalledOnce();
    });
  });

  describe('disconnect', () => {
    it('removes all subscriptions for the session — no further events for any symbol', () => {
      const registry = makeRegistry('CLZ26');
      const publisher = new MarketDataPublisher(registry);
      const handler = vi.fn();
      publisher.subscribe('SESSION-A', 'CLM26', handler);
      publisher.subscribe('SESSION-A', 'CLZ26', handler);

      publisher.disconnect('SESSION-A');

      const event: OrderBookEvent = {
        type: 'OrderAdded',
        order: {
          id: 'O1', symbol: 'CLM26', side: 'Buy', type: 'Limit',
          quantity: 10, price: 100.25, account: 'ACC1', trader: 'TDR1',
          state: 'New', filledQuantity: 0, timestamp: 1000,
        },
      };
      publisher.publish('CLM26', event);
      publisher.publish('CLZ26', event);

      expect(handler).not.toHaveBeenCalled();
    });

    it('disconnect does not affect subscriptions belonging to other sessions', () => {
      const registry = makeRegistry();
      const publisher = new MarketDataPublisher(registry);
      const handlerA = vi.fn();
      const handlerB = vi.fn();
      publisher.subscribe('SESSION-A', 'CLM26', handlerA);
      publisher.subscribe('SESSION-B', 'CLM26', handlerB);

      publisher.disconnect('SESSION-A');

      const event: OrderBookEvent = {
        type: 'OrderAdded',
        order: {
          id: 'O1', symbol: 'CLM26', side: 'Buy', type: 'Limit',
          quantity: 10, price: 100.25, account: 'ACC1', trader: 'TDR1',
          state: 'New', filledQuantity: 0, timestamp: 1000,
        },
      };
      publisher.publish('CLM26', event);

      expect(handlerA).not.toHaveBeenCalled();
      expect(handlerB).toHaveBeenCalledOnce();
    });
  });
});
