import type {
  CancellationRequest,
  NewOrder,
  Order,
  OrderStateUpdate,
  Side,
  SubmitResult,
} from '@matchingengine/shared-types';
import type { InstrumentRegistry } from './instrument-registry.js';

// ─── Public types ─────────────────────────────────────────────────────────────

/** Enriched data emitted to Gateway-layer subscribers when the market closes. */
export interface ClosedOrderInfo {
  orderId: string;
  sessionId: string;
  update: OrderStateUpdate;
  /** Original submitted quantity (before any fills). */
  originalQty: number;
  /** Side of the cancelled order, for building the Execution Report. */
  side: Side;
}

type ClosedOrdersHandler = (symbol: string, orders: ClosedOrderInfo[]) => void;

// ─── OrderManager ─────────────────────────────────────────────────────────────

export class OrderManager {
  /** orderId → sessionId: which session submitted this order */
  private readonly sessionByOrder = new Map<string, string>();
  /** orderId → symbol: which instrument this order belongs to */
  private readonly symbolByOrder = new Map<string, string>();
  /** orderId → original submitted quantity */
  private readonly quantityByOrder = new Map<string, number>();
  /** orderId → side */
  private readonly sideByOrder = new Map<string, Side>();

  private readonly closedOrdersHandlers: ClosedOrdersHandler[] = [];

  constructor(
    private readonly registry: InstrumentRegistry,
    private readonly generateId: () => string = () => crypto.randomUUID(),
  ) {
    registry.onOrdersCancelledOnClose((symbol, updates) => {
      // Build enriched list while session/qty/side info is still available.
      const enriched: ClosedOrderInfo[] = [];
      for (const update of updates) {
        const sessionId = this.sessionByOrder.get(update.orderId);
        if (sessionId !== undefined) {
          enriched.push({
            orderId: update.orderId,
            sessionId,
            update,
            originalQty: this.quantityByOrder.get(update.orderId) ?? 0,
            side: this.sideByOrder.get(update.orderId) ?? 'Buy',
          });
        }
      }

      // Notify Gateway-layer subscribers BEFORE cleaning up maps.
      for (const handler of this.closedOrdersHandlers) {
        handler(symbol, enriched);
      }

      // Cleanup
      for (const update of updates) {
        this.sessionByOrder.delete(update.orderId);
        this.symbolByOrder.delete(update.orderId);
        this.quantityByOrder.delete(update.orderId);
        this.sideByOrder.delete(update.orderId);
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
    this.quantityByOrder.set(order.id, newOrder.quantity);
    this.sideByOrder.set(order.id, newOrder.side);

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
    let update: OrderStateUpdate;
    try {
      update = this.registry.cancel(request.orderId, symbol);
    } catch {
      // Order is no longer in the book (e.g. already Filled).
      return {
        orderId: request.orderId,
        state: 'Rejected',
        filledQuantity: 0,
        cancelReason: 'CannotCancelFilledOrder',
      };
    }

    this.sessionByOrder.delete(request.orderId);
    this.symbolByOrder.delete(request.orderId);
    this.quantityByOrder.delete(request.orderId);
    this.sideByOrder.delete(request.orderId);
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
        this.quantityByOrder.delete(orderId);
        this.sideByOrder.delete(orderId);
      }
    }
  }

  /** Subscribe to engine-initiated cancellations (market close / expiry). */
  onOrdersCancelledOnClose(handler: ClosedOrdersHandler): void {
    this.closedOrdersHandlers.push(handler);
  }
}
