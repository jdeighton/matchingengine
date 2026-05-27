// ─── Primitive domain types ───────────────────────────────────────────────

export type Side = 'Buy' | 'Sell';
export type OrderType = 'Market' | 'Limit';
export type OrderState = 'New' | 'PartiallyFilled' | 'Filled' | 'Cancelled' | 'Rejected';
export type MarketState = 'Closed' | 'Open' | 'Halted';
export type CancelReason =
  | 'InsufficientLiquidity' // Market order remainder, or market order vs empty book
  | 'MarketClose' // Instrument transitioned to Closed
  | 'ClientRequest' // Client-submitted Cancellation Request
  | 'CrossSessionCancel' // Cancellation Request from a different Session — rejected
  | 'CannotCancelFilledOrder'; // Cancellation Request for an already-Filled Order

// ─── Instrument ───────────────────────────────────────────────────────────

/** Static data describing a tradeable entity. */
export interface InstrumentDefinition {
  symbol: string;
  name: string;
  /** Minimum valid price increment. Prices must be whole multiples of tickSize. */
  tickSize: number;
  contractSize: number;
  currency: string;
  expiryDate: Date;
}

/** InstrumentDefinition plus its current Market State. */
export interface Instrument extends InstrumentDefinition {
  marketState: MarketState;
}

// ─── Orders ───────────────────────────────────────────────────────────────

/**
 * The working entity tracked by the Engine from submission through to a
 * terminal state. Created from a NewOrder; lives in the Order Book until
 * matched, cancelled, or the market closes.
 */
export interface Order {
  id: string;
  symbol: string;
  side: Side;
  type: OrderType;
  /** Total original quantity. */
  quantity: number;
  /** Limit price. Required for Limit orders; absent for Market orders. */
  price?: number;
  account: string;
  trader: string;
  state: OrderState;
  /** Quantity filled so far. */
  filledQuantity: number;
  /** Monotonically increasing timestamp used for FIFO priority within a price level. */
  timestamp: number;
}

/** A client's instruction to create an Order. */
export interface NewOrder {
  symbol: string;
  side: Side;
  type: OrderType;
  quantity: number;
  /** Required for Limit orders. */
  price?: number;
  account: string;
  trader: string;
}

/** A client's instruction to cancel a specific resting Order. */
export interface CancellationRequest {
  orderId: string;
}

// ─── Matching results ─────────────────────────────────────────────────────

/** The record of a completed match between two Orders. */
export interface Trade {
  symbol: string;
  price: number;
  quantity: number;
  aggressingOrderId: string;
  restingOrderId: string;
}

/** A notification that an Order's state has changed. */
export interface OrderStateUpdate {
  orderId: string;
  state: OrderState;
  /** Quantity filled in this update (cumulative from order perspective). */
  filledQuantity: number;
  /** Present only when state is Cancelled or Rejected. */
  cancelReason?: CancelReason;
}

/** The result of submitting an Order to the Order Book. */
export interface SubmitResult {
  trades: Trade[];
  updates: OrderStateUpdate[];
}

// ─── Market Data ──────────────────────────────────────────────────────────

export type OrderBookEventType = 'OrderAdded' | 'OrderCancelled' | 'OrderFilled' | 'OrderPartiallyFilled';

export interface OrderBookEvent {
  type: OrderBookEventType;
  order: Order;
}

export interface TradeEvent {
  trade: Trade;
}

/** A complete snapshot of all resting Orders in an Order Book. */
export interface Snapshot {
  symbol: string;
  orders: Order[];
}
