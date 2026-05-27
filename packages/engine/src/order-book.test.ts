import { describe, it, expect } from 'vitest';
import { OrderBook } from './order-book.js';
import type { Order } from '@matchingengine/shared-types';

// Helper: build a minimal resting Limit Order
function limitOrder(overrides: Partial<Order> & { id: string; side: Order['side'] }): Order {
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

describe('OrderBook', () => {
  describe('limit order with no matching counterparty', () => {
    it('rests in the book and appears in the snapshot', () => {
      const book = new OrderBook('CLM26');
      const order = limitOrder({ id: 'O1', side: 'Buy', price: 100.25 });

      book.submit(order);

      const resting = book.snapshot();
      expect(resting).toHaveLength(1);
      expect(resting[0].id).toBe('O1');
    });

    it('returns no trades and a New state update', () => {
      const book = new OrderBook('CLM26');
      const order = limitOrder({ id: 'O1', side: 'Buy', price: 100.25 });

      const result = book.submit(order);

      expect(result.trades).toHaveLength(0);
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0]).toMatchObject({ orderId: 'O1', state: 'New', filledQuantity: 0 });
    });
  });

  describe('market order partial fill — remainder cancelled', () => {
    it('fills what is available and cancels the rest with InsufficientLiquidity', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Buy', price: 100.25, quantity: 5 }));

      const aggressor: Order = {
        ...limitOrder({ id: 'O2', side: 'Sell', price: undefined }),
        type: 'Market',
        quantity: 10,
        price: undefined,
      };
      const result = book.submit(aggressor);

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].quantity).toBe(5);

      const aggressorUpdate = result.updates.find((u) => u.orderId === 'O2');
      expect(aggressorUpdate).toMatchObject({
        state: 'Cancelled',
        filledQuantity: 5,
        cancelReason: 'InsufficientLiquidity',
      });
    });

    it('removes the aggressor from the book after partial fill cancellation', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Buy', price: 100.25, quantity: 5 }));

      const aggressor: Order = {
        ...limitOrder({ id: 'O2', side: 'Sell', price: undefined }),
        type: 'Market',
        quantity: 10,
        price: undefined,
      };
      book.submit(aggressor);

      expect(book.snapshot()).toHaveLength(0);
    });

    it('cancels a market order immediately when the book is empty', () => {
      const book = new OrderBook('CLM26');

      const aggressor: Order = {
        ...limitOrder({ id: 'O1', side: 'Buy', price: undefined }),
        type: 'Market',
        quantity: 10,
        price: undefined,
      };
      const result = book.submit(aggressor);

      expect(result.trades).toHaveLength(0);
      expect(result.updates[0]).toMatchObject({
        orderId: 'O1',
        state: 'Cancelled',
        filledQuantity: 0,
        cancelReason: 'InsufficientLiquidity',
      });
    });
  });

  describe('limit-vs-limit price improvement', () => {
    it('aggressing buy limit executes at the resting sell price, not its own limit', () => {
      const book = new OrderBook('CLM26');
      // Resting sell at 100.25
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.25, quantity: 10 }));

      // Aggressing buy willing to pay up to 100.50 — should get the better price of 100.25
      const result = book.submit(limitOrder({ id: 'O2', side: 'Buy', price: 100.50, quantity: 10 }));

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].price).toBe(100.25);
    });

    it('aggressing sell limit executes at the resting buy price, not its own limit', () => {
      const book = new OrderBook('CLM26');
      // Resting buy at 100.50
      book.submit(limitOrder({ id: 'O1', side: 'Buy', price: 100.50, quantity: 10 }));

      // Aggressing sell willing to sell as low as 100.25 — should get the better price of 100.50
      const result = book.submit(limitOrder({ id: 'O2', side: 'Sell', price: 100.25, quantity: 10 }));

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].price).toBe(100.50);
    });

    it('aggressing limit order at exactly the resting price still executes', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.25, quantity: 10 }));

      const result = book.submit(limitOrder({ id: 'O2', side: 'Buy', price: 100.25, quantity: 10 }));

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0].price).toBe(100.25);
    });

    it('aggressing limit order that does not cross the spread rests in the book', () => {
      const book = new OrderBook('CLM26');
      // Resting sell at 100.50
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.50, quantity: 10 }));

      // Buy only willing to pay 100.25 — does not cross
      const result = book.submit(limitOrder({ id: 'O2', side: 'Buy', price: 100.25, quantity: 10 }));

      expect(result.trades).toHaveLength(0);
      expect(result.updates[0]).toMatchObject({ orderId: 'O2', state: 'New' });
      expect(book.snapshot()).toHaveLength(2);
    });
  });

  describe('FIFO priority at the same price level', () => {
    it('fills the earlier-submitted resting order first', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.25, quantity: 10, timestamp: 1000 }));
      book.submit(limitOrder({ id: 'O2', side: 'Sell', price: 100.25, quantity: 10, timestamp: 2000 }));

      const aggressor: Order = {
        ...limitOrder({ id: 'O3', side: 'Buy', price: undefined }),
        type: 'Market',
        quantity: 5,
        price: undefined,
      };
      const result = book.submit(aggressor);

      expect(result.trades[0].restingOrderId).toBe('O1');
    });

    it('moves to the next resting order once the first is filled', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.25, quantity: 5, timestamp: 1000 }));
      book.submit(limitOrder({ id: 'O2', side: 'Sell', price: 100.25, quantity: 10, timestamp: 2000 }));

      const aggressor: Order = {
        ...limitOrder({ id: 'O3', side: 'Buy', price: undefined }),
        type: 'Market',
        quantity: 10,
        price: undefined,
      };
      const result = book.submit(aggressor);

      expect(result.trades).toHaveLength(2);
      expect(result.trades[0].restingOrderId).toBe('O1');
      expect(result.trades[1].restingOrderId).toBe('O2');
    });

    it('price priority: better-priced order fills before a same-side order at a worse price', () => {
      const book = new OrderBook('CLM26');
      // Two resting sells — lower ask price is better (fills first)
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.50, quantity: 10, timestamp: 1000 }));
      book.submit(limitOrder({ id: 'O2', side: 'Sell', price: 100.25, quantity: 10, timestamp: 2000 }));

      const aggressor: Order = {
        ...limitOrder({ id: 'O3', side: 'Buy', price: undefined }),
        type: 'Market',
        quantity: 5,
        price: undefined,
      };
      const result = book.submit(aggressor);

      // O2 has the better (lower) ask price — fills first despite later timestamp
      expect(result.trades[0].restingOrderId).toBe('O2');
      expect(result.trades[0].price).toBe(100.25);
    });
  });

  describe('partial limit fill — residual remains resting', () => {
    it('transitions to PartiallyFilled and keeps the residual in the book', () => {
      const book = new OrderBook('CLM26');
      // Resting sell of 5 — aggressing buy of 10, only 5 can match
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.25, quantity: 5 }));

      const result = book.submit(limitOrder({ id: 'O2', side: 'Buy', price: 100.25, quantity: 10 }));

      const aggressorUpdate = result.updates.find((u) => u.orderId === 'O2');
      expect(aggressorUpdate).toMatchObject({ state: 'PartiallyFilled', filledQuantity: 5 });
    });

    it('residual quantity stays resting in the book after a partial fill', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.25, quantity: 5 }));
      book.submit(limitOrder({ id: 'O2', side: 'Buy', price: 100.25, quantity: 10 }));

      const resting = book.snapshot();
      expect(resting).toHaveLength(1);
      expect(resting[0].id).toBe('O2');
      expect(resting[0].filledQuantity).toBe(5);
      expect(resting[0].quantity).toBe(10);
    });

    it('a second aggressor fills the residual of a partially-filled limit order', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.25, quantity: 5 }));
      book.submit(limitOrder({ id: 'O2', side: 'Buy', price: 100.25, quantity: 10 }));

      // Now O2 rests with 5 unfilled — send a sell to fill the rest
      const result = book.submit(limitOrder({ id: 'O3', side: 'Sell', price: 100.25, quantity: 5 }));

      const o2Update = result.updates.find((u) => u.orderId === 'O2');
      expect(o2Update).toMatchObject({ state: 'Filled', filledQuantity: 10 });
      expect(book.snapshot()).toHaveLength(0);
    });
  });

  describe('cancel', () => {
    it('removes a resting order from the book', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Buy', price: 100.25 }));

      book.cancel('O1');

      expect(book.snapshot()).toHaveLength(0);
    });

    it('returns a Cancelled update with ClientRequest reason', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Buy', price: 100.25, quantity: 10 }));

      const update = book.cancel('O1');

      expect(update).toMatchObject({
        orderId: 'O1',
        state: 'Cancelled',
        filledQuantity: 0,
        cancelReason: 'ClientRequest',
      });
    });

    it('returns the correct filledQuantity for a partially-filled order that is cancelled', () => {
      const book = new OrderBook('CLM26');
      // Resting sell of 5 partially fills the buy of 10
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.25, quantity: 5 }));
      book.submit(limitOrder({ id: 'O2', side: 'Buy', price: 100.25, quantity: 10 }));

      const update = book.cancel('O2');

      expect(update).toMatchObject({ orderId: 'O2', state: 'Cancelled', filledQuantity: 5 });
    });

    it('throws when cancelling an unknown order ID', () => {
      const book = new OrderBook('CLM26');

      expect(() => book.cancel('UNKNOWN')).toThrow();
    });
  });

  describe('snapshot', () => {
    it('returns bids highest-price first', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Buy', price: 100.00, timestamp: 1000 }));
      book.submit(limitOrder({ id: 'O2', side: 'Buy', price: 100.50, timestamp: 2000 }));
      book.submit(limitOrder({ id: 'O3', side: 'Buy', price: 100.25, timestamp: 3000 }));

      const snap = book.snapshot().filter((o) => o.side === 'Buy');

      expect(snap.map((o) => o.price)).toEqual([100.50, 100.25, 100.00]);
    });

    it('returns asks lowest-price first', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Sell', price: 100.50, timestamp: 1000 }));
      book.submit(limitOrder({ id: 'O2', side: 'Sell', price: 100.00, timestamp: 2000 }));
      book.submit(limitOrder({ id: 'O3', side: 'Sell', price: 100.25, timestamp: 3000 }));

      const snap = book.snapshot().filter((o) => o.side === 'Sell');

      expect(snap.map((o) => o.price)).toEqual([100.00, 100.25, 100.50]);
    });

    it('breaks price ties by timestamp — earlier order first', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Buy', price: 100.25, timestamp: 3000 }));
      book.submit(limitOrder({ id: 'O2', side: 'Buy', price: 100.25, timestamp: 1000 }));
      book.submit(limitOrder({ id: 'O3', side: 'Buy', price: 100.25, timestamp: 2000 }));

      const snap = book.snapshot().filter((o) => o.side === 'Buy');

      expect(snap.map((o) => o.id)).toEqual(['O2', 'O3', 'O1']);
    });
  });

  describe('market order immediate full fill', () => {
    it('executes against the best resting limit order and produces a trade', () => {
      const book = new OrderBook('CLM26');
      const resting = limitOrder({ id: 'O1', side: 'Buy', price: 100.25, quantity: 10 });
      book.submit(resting);

      const aggressor: Order = {
        ...limitOrder({ id: 'O2', side: 'Sell', price: undefined }),
        type: 'Market',
        quantity: 10,
        price: undefined,
      };

      const result = book.submit(aggressor);

      expect(result.trades).toHaveLength(1);
      expect(result.trades[0]).toMatchObject({
        price: 100.25,
        quantity: 10,
        aggressingOrderId: 'O2',
        restingOrderId: 'O1',
      });
    });

    it('removes the resting order from the book after a full fill', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Buy', price: 100.25, quantity: 10 }));

      const aggressor: Order = {
        ...limitOrder({ id: 'O2', side: 'Sell', price: undefined }),
        type: 'Market',
        quantity: 10,
        price: undefined,
      };
      book.submit(aggressor);

      expect(book.snapshot()).toHaveLength(0);
    });

    it('marks both orders as Filled', () => {
      const book = new OrderBook('CLM26');
      book.submit(limitOrder({ id: 'O1', side: 'Buy', price: 100.25, quantity: 10 }));

      const aggressor: Order = {
        ...limitOrder({ id: 'O2', side: 'Sell', price: undefined }),
        type: 'Market',
        quantity: 10,
        price: undefined,
      };
      const result = book.submit(aggressor);

      const filled = (id: string) => result.updates.find((u) => u.orderId === id);
      expect(filled('O1')).toMatchObject({ state: 'Filled', filledQuantity: 10 });
      expect(filled('O2')).toMatchObject({ state: 'Filled', filledQuantity: 10 });
    });
  });
});
