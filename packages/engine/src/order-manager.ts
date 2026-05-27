import type {
  CancellationRequest,
  NewOrder,
  Order,
  OrderStateUpdate,
  SubmitResult,
} from '@matchingengine/shared-types';
import type { InstrumentRegistry } from './instrument-registry.js';

export class OrderManager {
  /** orderId → sessionId: which session submitted this order */
  private readonly sessionByOrder = new Map<string, string>();
  /** orderId → symbol: which instrument this order belongs to */
  private readonly symbolByOrder = new Map<string, string>();

  constructor(
    private readonly registry: InstrumentRegistry,
    private readonly generateId: () => string = () => crypto.randomUUID(),
  ) {
    registry.onOrdersCancelledOnClose((_symbol, updates) => {
      for (const update of updates) {
        this.sessionByOrder.delete(update.orderId);
        this.symbolByOrder.delete(update.orderId);
      }
    });
  }

  place(newOrder: NewOrder, sessionId: string): SubmitResult {
    const order: Order = {
      ...newOrder,
      id: this.generateId(),
      state: 'New',
      filledQuantity: 0,
      timestamp: Date.now(),
    };

    const result = this.registry.submit(order);

    // Register the new order's session. Only the new order (the aggressor) is
    // registered here — resting orders were registered when they were first placed
    // and must not be overwritten with the aggressor's session.
    this.sessionByOrder.set(order.id, sessionId);
    this.symbolByOrder.set(order.id, newOrder.symbol);

    return result;
  }

  cancel(request: CancellationRequest, sessionId: string): OrderStateUpdate {
    const ownerSession = this.sessionByOrder.get(request.orderId);

    if (ownerSession === undefined) {
      return {
        orderId: request.orderId,
        state: 'Rejected',
        filledQuantity: 0,
        cancelReason: 'CrossSessionCancel',
      };
    }

    if (ownerSession !== sessionId) {
      return {
        orderId: request.orderId,
        state: 'Rejected',
        filledQuantity: 0,
        cancelReason: 'CrossSessionCancel',
      };
    }

    const symbol = this.symbolByOrder.get(request.orderId)!;
    const update = this.registry.cancel(request.orderId, symbol);
    this.sessionByOrder.delete(request.orderId);
    this.symbolByOrder.delete(request.orderId);
    return update;
  }

  getSession(orderId: string): string | undefined {
    return this.sessionByOrder.get(orderId);
  }

  onSessionDisconnect(sessionId: string): void {
    for (const [orderId, session] of this.sessionByOrder) {
      if (session === sessionId) {
        this.sessionByOrder.delete(orderId);
        this.symbolByOrder.delete(orderId);
      }
    }
  }
}
