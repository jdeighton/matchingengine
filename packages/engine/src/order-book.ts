import type { Order, SubmitResult, OrderStateUpdate, Trade } from '@matchingengine/shared-types';

export class OrderBook {
  private readonly bids: Order[] = []; // Buy side, sorted best (highest) price first
  private readonly asks: Order[] = []; // Sell side, sorted best (lowest) price first

  constructor(readonly symbol: string) {}

  submit(order: Order): SubmitResult {
    const trades: Trade[] = [];
    const updates: OrderStateUpdate[] = [];

    const counterSide = order.side === 'Buy' ? this.asks : this.bids;

    let remainingQty = order.quantity;

    while (remainingQty > 0 && counterSide.length > 0) {
      const best = counterSide[0];

      // Price check: market orders always cross; limit orders must cross the spread
      const crosses =
        order.type === 'Market' ||
        (order.side === 'Buy' ? order.price! >= best.price! : order.price! <= best.price!);

      if (!crosses) break;

      const fillQty = Math.min(remainingQty, best.quantity - best.filledQuantity);
      const fillPrice = best.price!; // Resting order sets the price

      trades.push({
        symbol: this.symbol,
        price: fillPrice,
        quantity: fillQty,
        aggressingOrderId: order.id,
        restingOrderId: best.id,
      });

      remainingQty -= fillQty;
      best.filledQuantity += fillQty;
      order.filledQuantity += fillQty;

      if (best.filledQuantity >= best.quantity) {
        counterSide.shift();
        best.state = 'Filled';
        updates.push({ orderId: best.id, state: 'Filled', filledQuantity: best.filledQuantity });
      } else {
        // Resting order partially filled — stays in the book but its state change is reported
        best.state = 'PartiallyFilled';
        updates.push({ orderId: best.id, state: 'PartiallyFilled', filledQuantity: best.filledQuantity });
      }
    }

    // Determine aggressing order's final state
    if (order.filledQuantity >= order.quantity) {
      order.state = 'Filled';
      updates.push({ orderId: order.id, state: 'Filled', filledQuantity: order.filledQuantity });
    } else if (order.type === 'Market') {
      // Market orders never rest — cancel the remainder
      order.state = 'Cancelled';
      updates.push({
        orderId: order.id,
        state: 'Cancelled',
        filledQuantity: order.filledQuantity,
        cancelReason: 'InsufficientLiquidity',
      });
    } else {
      // Limit order: rest the remainder in the book in price/time priority order
      this.insertResting(order);
      order.state = order.filledQuantity > 0 ? 'PartiallyFilled' : 'New';
      updates.push({ orderId: order.id, state: order.state, filledQuantity: order.filledQuantity });
    }

    return { trades, updates };
  }

  private insertResting(order: Order): void {
    const side = order.side === 'Buy' ? this.bids : this.asks;
    // Bids: highest price first; asks: lowest price first.
    // Within the same price, earlier timestamp first (FIFO).
    const beats = order.side === 'Buy'
      ? (incoming: Order, existing: Order) =>
          incoming.price! > existing.price! ||
          (incoming.price! === existing.price! && incoming.timestamp < existing.timestamp)
      : (incoming: Order, existing: Order) =>
          incoming.price! < existing.price! ||
          (incoming.price! === existing.price! && incoming.timestamp < existing.timestamp);

    const idx = side.findIndex((existing) => beats(order, existing));
    if (idx === -1) {
      side.push(order);
    } else {
      side.splice(idx, 0, order);
    }
  }

  cancel(orderId: string): OrderStateUpdate {
    for (const side of [this.bids, this.asks]) {
      const idx = side.findIndex((o) => o.id === orderId);
      if (idx !== -1) {
        const [removed] = side.splice(idx, 1);
        removed.state = 'Cancelled';
        return { orderId, state: 'Cancelled', filledQuantity: removed.filledQuantity, cancelReason: 'ClientRequest' };
      }
    }
    throw new Error(`Order not found: ${orderId}`);
  }

  snapshot(): Order[] {
    return [...this.bids, ...this.asks];
  }
}
