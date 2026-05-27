import { describe, it, expect, vi, afterEach } from 'vitest';
import { InstrumentRegistry } from './instrument-registry.js';
import type { InstrumentDefinition, Order, OrderStateUpdate } from '@matchingengine/shared-types';

// ─── Helpers ──────────────────────────────────────────────────────────────

function makeInstrumentDef(overrides?: Partial<InstrumentDefinition>): InstrumentDefinition {
  return {
    symbol: 'CLM26',
    name: 'Crude Light March 2026',
    tickSize: 0.25,
    contractSize: 1000,
    currency: 'USD',
    expiryDate: new Date('2026-03-31'),
    ...overrides,
  };
}

function makeOrder(overrides: Partial<Order> & { id: string; side: Order['side'] }): Order {
  return {
    symbol: 'CLM26',
    type: 'Limit',
    quantity: 10,
    price: 100.25,
    account: 'ACC1',
    trader: 'TDR1',
    state: 'New',
    filledQuantity: 0,
    timestamp: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

// ─── Tests ────────────────────────────────────────────────────────────────

describe('InstrumentRegistry', () => {
  describe('instrument lifecycle', () => {
    it('adds an instrument and retrieves it by Symbol', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());

      const instrument = registry.get('CLM26');

      expect(instrument).toBeDefined();
      expect(instrument!.symbol).toBe('CLM26');
      expect(instrument!.marketState).toBe('Closed');
    });

    it('newly added instrument starts in Closed state', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      expect(registry.get('CLM26')!.marketState).toBe('Closed');
    });

    it('lists all added instruments', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef({ symbol: 'CLM26' }));
      registry.add(makeInstrumentDef({ symbol: 'CLZ26' }));

      const symbols = registry.list().map((i) => i.symbol);
      expect(symbols).toContain('CLM26');
      expect(symbols).toContain('CLZ26');
      expect(symbols).toHaveLength(2);
    });

    it('throws when adding a duplicate Symbol', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      expect(() => registry.add(makeInstrumentDef())).toThrow();
    });

    it('delists an instrument — no longer returned by get or list', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      registry.delist('CLM26');

      expect(registry.get('CLM26')).toBeUndefined();
      expect(registry.list()).toHaveLength(0);
    });
  });

  describe('Market State machine', () => {
    it('transitions Closed → Open', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      registry.setMarketState('CLM26', 'Open');
      expect(registry.get('CLM26')!.marketState).toBe('Open');
    });

    it('transitions Open → Halted → Open → Closed', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      registry.setMarketState('CLM26', 'Open');
      registry.setMarketState('CLM26', 'Halted');
      registry.setMarketState('CLM26', 'Open');
      registry.setMarketState('CLM26', 'Closed');
      expect(registry.get('CLM26')!.marketState).toBe('Closed');
    });

    it('transitions Halted → Closed directly', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      registry.setMarketState('CLM26', 'Open');
      registry.setMarketState('CLM26', 'Halted');
      registry.setMarketState('CLM26', 'Closed');
      expect(registry.get('CLM26')!.marketState).toBe('Closed');
    });

    it('rejects Closed → Halted (invalid transition)', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      expect(() => registry.setMarketState('CLM26', 'Halted')).toThrow(/Closed → Halted/);
    });

    it('rejects Open → Open (no self-transition)', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      registry.setMarketState('CLM26', 'Open');
      expect(() => registry.setMarketState('CLM26', 'Open')).toThrow();
    });

    it('emits marketStateChanged with symbol and new state', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      const events: Array<{ symbol: string; state: string }> = [];
      registry.onMarketStateChanged((symbol, state) => events.push({ symbol, state }));

      registry.setMarketState('CLM26', 'Open');
      registry.setMarketState('CLM26', 'Halted');

      expect(events).toEqual([
        { symbol: 'CLM26', state: 'Open' },
        { symbol: 'CLM26', state: 'Halted' },
      ]);
    });
  });

  describe('cancel on close', () => {
    it('cancels all resting orders when transitioning to Closed', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      registry.setMarketState('CLM26', 'Open');
      registry.submit(makeOrder({ id: 'O1', side: 'Buy' }));
      registry.submit(makeOrder({ id: 'O2', side: 'Buy', price: 100.00 }));

      registry.setMarketState('CLM26', 'Closed');

      // Both orders should be gone from the book
      const result = registry.submit(makeOrder({ id: 'O3', side: 'Sell' }));
      // If orders were cancelled the book is empty — O3 is rejected (Closed), not filled
      expect(result.updates[0].state).toBe('Rejected');
    });

    it('emits ordersClosedOnMarketClose with the cancellation updates', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      registry.setMarketState('CLM26', 'Open');
      registry.submit(makeOrder({ id: 'O1', side: 'Buy' }));
      registry.submit(makeOrder({ id: 'O2', side: 'Buy', price: 100.00 }));

      const events: OrderStateUpdate[][] = [];
      registry.onOrdersCancelledOnClose((_symbol, updates) => events.push(updates));

      registry.setMarketState('CLM26', 'Closed');

      expect(events).toHaveLength(1);
      expect(events[0]).toHaveLength(2);
      const ids = events[0].map((u) => u.orderId);
      expect(ids).toContain('O1');
      expect(ids).toContain('O2');
      expect(events[0].every((u) => u.state === 'Cancelled')).toBe(true);
    });

    it('does not emit ordersClosedOnMarketClose when the book is empty', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      registry.setMarketState('CLM26', 'Open');

      const events: unknown[] = [];
      registry.onOrdersCancelledOnClose(() => events.push(true));
      registry.setMarketState('CLM26', 'Closed');

      expect(events).toHaveLength(0);
    });
  });

  describe('order rejection when market is Closed or Halted', () => {
    it('rejects a New Order submitted to a Closed instrument', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      // market stays Closed

      const result = registry.submit(makeOrder({ id: 'O1', side: 'Buy' }));

      expect(result.updates[0]).toMatchObject({ orderId: 'O1', state: 'Rejected' });
      expect(result.trades).toHaveLength(0);
    });

    it('rejects a New Order submitted to a Halted instrument', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      registry.setMarketState('CLM26', 'Open');
      registry.setMarketState('CLM26', 'Halted');

      const result = registry.submit(makeOrder({ id: 'O1', side: 'Buy' }));

      expect(result.updates[0]).toMatchObject({ orderId: 'O1', state: 'Rejected' });
    });

    it('accepts a New Order when the instrument is Open', () => {
      const registry = new InstrumentRegistry();
      registry.add(makeInstrumentDef());
      registry.setMarketState('CLM26', 'Open');

      const result = registry.submit(makeOrder({ id: 'O1', side: 'Buy' }));

      expect(result.updates[0]).toMatchObject({ orderId: 'O1', state: 'New' });
    });
  });

  describe('automatic expiry close', () => {
    it('automatically closes the instrument when its expiry date is reached', () => {
      vi.useFakeTimers();
      const registry = new InstrumentRegistry();
      const expiryDate = new Date(Date.now() + 5000);
      registry.add(makeInstrumentDef({ expiryDate }));
      registry.setMarketState('CLM26', 'Open');

      vi.advanceTimersByTime(5001);

      expect(registry.get('CLM26')!.marketState).toBe('Closed');
    });

    it('cancels resting orders on expiry close', () => {
      vi.useFakeTimers();
      const registry = new InstrumentRegistry();
      const expiryDate = new Date(Date.now() + 5000);
      registry.add(makeInstrumentDef({ expiryDate }));
      registry.setMarketState('CLM26', 'Open');
      registry.submit(makeOrder({ id: 'O1', side: 'Buy' }));

      const events: OrderStateUpdate[][] = [];
      registry.onOrdersCancelledOnClose((_symbol, updates) => events.push(updates));

      vi.advanceTimersByTime(5001);

      expect(events).toHaveLength(1);
      expect(events[0][0]).toMatchObject({ orderId: 'O1', state: 'Cancelled' });
    });

    it('does not fire after delist', () => {
      vi.useFakeTimers();
      const registry = new InstrumentRegistry();
      const expiryDate = new Date(Date.now() + 5000);
      registry.add(makeInstrumentDef({ expiryDate }));
      registry.setMarketState('CLM26', 'Open');
      registry.delist('CLM26');

      // Should not throw — the expiry timer fires but the instrument is gone
      expect(() => vi.advanceTimersByTime(5001)).not.toThrow();
    });
  });
});
