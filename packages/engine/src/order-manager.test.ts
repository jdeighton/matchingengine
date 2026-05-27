import { describe, it, expect } from 'vitest';
import { OrderManager } from './order-manager.js';
import { InstrumentRegistry } from './instrument-registry.js';
import type { InstrumentDefinition, NewOrder } from '@matchingengine/shared-types';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeRegistry(): InstrumentRegistry {
  const registry = new InstrumentRegistry();
  registry.add(makeInstrumentDef());
  registry.setMarketState('CLM26', 'Open');
  return registry;
}

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

// Predictable sequential IDs for tests
function makeIdGen(): () => string {
  let n = 0;
  return () => `O${++n}`;
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('OrderManager', () => {
  describe('place', () => {
    it('routes the New Order to the registry and returns the state update', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());

      const result = manager.place(makeNewOrder(), 'SESSION-A');

      expect(result.updates).toHaveLength(1);
      expect(result.updates[0]).toMatchObject({ state: 'New', filledQuantity: 0 });
    });

    it('records the orderId → sessionId mapping so getSession works', () => {
      const registry = makeRegistry();
      const idGen = makeIdGen();
      const manager = new OrderManager(registry, idGen);

      manager.place(makeNewOrder(), 'SESSION-A');

      expect(manager.getSession('O1')).toBe('SESSION-A');
    });

    it('returns trades when the order matches immediately', () => {
      const registry = makeRegistry();
      const idGen = makeIdGen();
      const manager = new OrderManager(registry, idGen);

      // Place a resting sell
      manager.place(makeNewOrder({ side: 'Sell', price: 100.25 }), 'SESSION-A');
      // Aggress with a buy — should match
      const result = manager.place(makeNewOrder({ side: 'Buy', price: 100.25 }), 'SESSION-B');

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].price).toBe(100.25);
    });

    it('returns Rejected update when the instrument is Closed', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      // leave market Closed
      const manager = new OrderManager(registry, makeIdGen());

      const result = manager.place(makeNewOrder(), 'SESSION-A');

      expect(result.updates[0].state).toBe('Rejected');
    });
  });

  describe('cancel', () => {
    it('succeeds when the Cancellation Request comes from the originating Session', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());
      manager.place(makeNewOrder(), 'SESSION-A');

      const update = manager.cancel({ orderId: 'O1' }, 'SESSION-A');

      expect(update).toMatchObject({ orderId: 'O1', state: 'Cancelled' });
    });

    it('returns Rejected when the Cancellation Request comes from a different Session', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());
      manager.place(makeNewOrder(), 'SESSION-A');

      const update = manager.cancel({ orderId: 'O1' }, 'SESSION-B');

      expect(update).toMatchObject({ orderId: 'O1', state: 'Rejected', cancelReason: 'CrossSessionCancel' });
    });

    it('returns Rejected for an unknown order ID', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());

      const update = manager.cancel({ orderId: 'UNKNOWN' }, 'SESSION-A');

      expect(update.state).toBe('Rejected');
    });
  });

  describe('getSession', () => {
    it('returns the session ID for a known order', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());
      manager.place(makeNewOrder(), 'SESSION-A');

      expect(manager.getSession('O1')).toBe('SESSION-A');
    });

    it('returns undefined for an unknown order ID', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());

      expect(manager.getSession('NO-SUCH-ORDER')).toBeUndefined();
    });
  });

  describe('onSessionDisconnect', () => {
    it('removes all orderId mappings for the disconnected session', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());
      manager.place(makeNewOrder(), 'SESSION-A');
      manager.place(makeNewOrder(), 'SESSION-A');
      manager.place(makeNewOrder(), 'SESSION-B');

      manager.onSessionDisconnect('SESSION-A');

      expect(manager.getSession('O1')).toBeUndefined();
      expect(manager.getSession('O2')).toBeUndefined();
    });

    it('does not remove mappings belonging to other sessions', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());
      manager.place(makeNewOrder(), 'SESSION-A');
      manager.place(makeNewOrder(), 'SESSION-B');

      manager.onSessionDisconnect('SESSION-A');

      expect(manager.getSession('O2')).toBe('SESSION-B');
    });

    it('leaves resting orders in the book — they are not cancelled on disconnect', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());
      manager.place(makeNewOrder({ side: 'Buy', price: 100.25 }), 'SESSION-A');

      manager.onSessionDisconnect('SESSION-A');

      // Market is still open; place a matching sell — O1 should still be resting
      const result = manager.place(makeNewOrder({ side: 'Sell', price: 100.25 }), 'SESSION-B');
      expect(result.trades).toHaveLength(1);
    });
  });

  describe('ordersClosedOnMarketClose cleanup', () => {
    it('removes session mappings for orders cancelled by a market close', () => {
      const registry = makeRegistry();
      const manager = new OrderManager(registry, makeIdGen());
      manager.place(makeNewOrder(), 'SESSION-A');

      // Close the market — triggers cancel-on-close in the registry
      registry.setMarketState('CLM26', 'Closed');

      // Mapping should be cleaned up
      expect(manager.getSession('O1')).toBeUndefined();
    });
  });
});
