import type { IFixEngine, IFixSession, IMessage, SessionConfig } from './fix-engine.js';
import type { ClosedOrderInfo, OrderManager, MarketDataPublisher, InstrumentRegistry } from '@matchingengine/engine';
import type { Order, OrderBookEventType, OrderState, OrderType, Side, SubmitResult, Trade } from '@matchingengine/shared-types';

// ─── FIX field constants ──────────────────────────────────────────────────────

const TAG = {
  MSG_TYPE:      35,
  CL_ORD_ID:    11,
  ORIG_CL_ORD_ID: 41,
  ACCOUNT:        1,
  SENDER_SUB_ID: 50,
  SYMBOL:        55,
  SIDE:          54,
  ORD_TYPE:      40,
  ORDER_QTY:     38,
  PRICE:         44,
  // ExecutionReport fields
  ORDER_ID:      37,
  EXEC_ID:       17,
  EXEC_TYPE:    150,
  ORD_STATUS:    39,
  CUM_QTY:       14,
  LEAVES_QTY:   151,
  AVG_PX:         6,
  TEXT:          58,
  // SecurityList / SecurityListRequest fields
  SECURITY_REQ_ID:         320,
  SECURITY_RESPONSE_ID:    322,
  SECURITY_REQUEST_RESULT: 560,
  NO_RELATED_SYM:          146,
  SECURITY_DESC:           107,
  CURRENCY:                 15,
  CONTRACT_MULTIPLIER:     231,
  MATURITY_DATE:           541,
  MIN_PRICE_INCREMENT:     969,
  // MarketData fields
  MD_REQ_ID:               262,
  SUBSCRIPTION_REQ_TYPE:   263,
  NO_MD_ENTRIES:           268,
  MD_ENTRY_TYPE:           269,
  MD_ENTRY_PX:             270,
  MD_ENTRY_SIZE:           271,
  MD_ENTRY_ID:             278,
  MD_UPDATE_ACTION:        279,
  MD_REQ_REJ_REASON:       281,
  // Reject reason fields
  ORD_REJ_REASON:          103,
  CXL_REJ_REASON:          102,
} as const;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toFIXStatus(state: OrderState): string {
  switch (state) {
    case 'New':             return '0';
    case 'PartiallyFilled': return '1';
    case 'Filled':          return '2';
    case 'Cancelled':       return '4';
    case 'Rejected':        return '8';
  }
}

/** Format a Date as a FIX date string (YYYYMMDD). */
function toFIXDate(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function isOnTick(price: number, tickSize: number): boolean {
  const ratio = price / tickSize;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
}

function toCxlRejReason(cancelReason: string | undefined): string {
  switch (cancelReason) {
    case 'CannotCancelFilledOrder': return '0'; // Too late to cancel
    case 'CrossSessionCancel':      return '1'; // Unknown order (to requesting session)
    case 'MissingOrderID':          return '1'; // Unknown order
    default:                        return '0';
  }
}

function toOrdRejReason(reason: string): string {
  if (reason.startsWith('Unknown symbol')) return '1'; // Unknown symbol
  if (reason.startsWith('Market is'))     return '2'; // Exchange closed
  return '99'; // Other
}

/**
 * Build a map of orderId → weighted-average execution price from a set of trades.
 * Both the aggressing and resting sides of each trade are recorded.
 */
function buildExecPrices(trades: Trade[]): Map<string, number> {
  const acc = new Map<string, { totalCost: number; totalQty: number }>();
  for (const trade of trades) {
    for (const orderId of [trade.aggressingOrderId, trade.restingOrderId]) {
      const entry = acc.get(orderId) ?? { totalCost: 0, totalQty: 0 };
      entry.totalCost += trade.price * trade.quantity;
      entry.totalQty += trade.quantity;
      acc.set(orderId, entry);
    }
  }
  const result = new Map<string, number>();
  for (const [orderId, { totalCost, totalQty }] of acc) {
    result.set(orderId, totalQty > 0 ? totalCost / totalQty : 0);
  }
  return result;
}

// ─── Gateway ──────────────────────────────────────────────────────────────────

export class Gateway {
  /** session id → status handler, so we can remove it on removeSession */
  private readonly handlers = new Map<string, (status: string) => void>();
  /** session id → last known status ('active' or 'inactive') */
  private readonly sessionStatuses = new Map<string, 'active' | 'inactive'>();
  private execIdSeq = 0;

  constructor(
    private readonly engine: IFixEngine,
    private readonly orderManager: OrderManager,
    private readonly publisher: MarketDataPublisher,
    private readonly registry: InstrumentRegistry,
  ) {
    // Wire engine-initiated cancellations (market close / expiry) → Execution Reports.
    this.orderManager.onOrdersCancelledOnClose((symbol, orders) => {
      for (const info of orders) {
        this.sendEngineInitiatedCancelER(symbol, info);
      }
    });
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────

  start(configs: SessionConfig[]): void {
    for (const config of configs) {
      const session = this.engine.addSession(config);
      this.watchSession(session);
    }
    this.engine.start();
    void this.runMessageLoop();
  }

  async stop(): Promise<void> {
    await this.engine.stop();
  }

  /**
   * Add a FIX session at runtime.
   * Returns the session ID assigned by the engine (senderCompId-targetCompId-beginString).
   */
  addSession(config: SessionConfig): string {
    const session = this.engine.addSession(config);
    this.watchSession(session);
    return session.id;
  }

  async removeSession(sessionId: string): Promise<void> {
    const session = this.engine.getSession(sessionId);
    const handler = this.handlers.get(sessionId);
    if (session && handler) {
      session.off('status', handler);
      this.handlers.delete(sessionId);
    }
    this.sessionStatuses.delete(sessionId);
    await this.engine.removeSession(sessionId);
  }

  /** Returns true if a session with the given ID is currently configured. */
  hasSession(sessionId: string): boolean {
    return this.engine.getSession(sessionId) !== undefined;
  }

  /**
   * List all configured sessions with their current connection status.
   * 'active' = FIX Logon completed; 'inactive' = any other state.
   */
  getSessions(): { sessionId: string; status: 'active' | 'inactive' }[] {
    return this.engine.getSessions().map((s) => ({
      sessionId: s.id,
      status: this.sessionStatuses.get(s.id) ?? 'inactive',
    }));
  }

  // ─── Message handling (public so tests can drive it directly) ────────────

  handleMessage(msg: IMessage): void {
    const msgType = msg.get(TAG.MSG_TYPE);
    if (msgType === 'D') this.handleNewOrder(msg);
    else if (msgType === 'F') this.handleCancelRequest(msg);
    else if (msgType === 'x') this.handleSecurityListRequest(msg);
    else if (msgType === 'V') this.handleMarketDataRequest(msg);
  }

  // ─── Private: session watcher ────────────────────────────────────────────

  private watchSession(session: IFixSession): void {
    this.sessionStatuses.set(session.id, 'inactive');
    const handler = (status: string) => {
      this.sessionStatuses.set(session.id, status === 'active' ? 'active' : 'inactive');
      if (status === 'disconnected') {
        this.orderManager.onSessionDisconnect(session.id);
        this.publisher.disconnect(session.id);
      }
    };
    this.handlers.set(session.id, handler);
    session.on('status', handler);
  }

  // ─── Private: async message loop ─────────────────────────────────────────

  private async runMessageLoop(): Promise<void> {
    for await (const msg of this.engine.messages()) {
      this.handleMessage(msg);
    }
  }

  // ─── Private: NewOrderSingle handler ─────────────────────────────────────

  private handleNewOrder(msg: IMessage): void {
    const sessionId = msg.sessionId;
    const clOrdId  = msg.get(TAG.CL_ORD_ID) ?? '';

    // ── 1. Required field validation ─────────────────────────────────────
    const symbol  = msg.get(TAG.SYMBOL);
    const sideRaw = msg.get(TAG.SIDE);
    const ordType = msg.get(TAG.ORD_TYPE);
    const qtyRaw  = msg.get(TAG.ORDER_QTY);
    const account = msg.get(TAG.ACCOUNT);
    const trader  = msg.get(TAG.SENDER_SUB_ID);

    if (!symbol || !sideRaw || !ordType || !qtyRaw || !account || !trader) {
      this.sendRejectER(sessionId, { clOrdId, symbol: symbol ?? '', sideRaw: sideRaw ?? '1', qty: 0, reason: 'Missing required field' });
      return;
    }

    // ── 2. Symbol validation ──────────────────────────────────────────────
    const instrument = this.registry.get(symbol);
    if (!instrument) {
      this.sendRejectER(sessionId, { clOrdId, symbol, sideRaw, qty: 0, reason: `Unknown symbol: ${symbol}` });
      return;
    }

    // ── 3. Market state validation ────────────────────────────────────────
    if (instrument.marketState === 'Closed' || instrument.marketState === 'Halted') {
      this.sendRejectER(sessionId, { clOrdId, symbol, sideRaw, qty: Number(qtyRaw), reason: `Market is ${instrument.marketState}` });
      return;
    }

    // ── 4. Price / tick size validation (Limit orders) ────────────────────
    const isLimit = ordType === '2';
    let price: number | undefined;
    if (isLimit) {
      const priceRaw = msg.get(TAG.PRICE);
      if (!priceRaw) {
        this.sendRejectER(sessionId, { clOrdId, symbol, sideRaw, qty: Number(qtyRaw), reason: 'Missing Price for Limit order' });
        return;
      }
      price = parseFloat(priceRaw);
      if (!isOnTick(price, instrument.tickSize)) {
        this.sendRejectER(sessionId, { clOrdId, symbol, sideRaw, qty: Number(qtyRaw), reason: 'Price not on tick' });
        return;
      }
    }

    // ── 5. Place order ────────────────────────────────────────────────────
    const side: Side = sideRaw === '1' ? 'Buy' : 'Sell';
    const qty = Number(qtyRaw);
    const orderType: OrderType = isLimit ? 'Limit' : 'Market';

    // Pre-placement snapshot: captures resting orders BEFORE they may be consumed.
    // Needed to reconstruct filled resting-order data for market data publishing.
    const preBook = new Map(this.registry.getSnapshot(symbol).orders.map(o => [o.id, o]));

    const result = this.orderManager.place(
      { symbol, side, type: orderType, quantity: qty, price, account, trader },
      sessionId,
    );

    // ── 6. Build execution-price map and post-trade snapshot ──────────────
    const execPrices = buildExecPrices(result.trades);

    // Snapshot taken AFTER the trade: resting/partial orders still in book
    // have their original quantity available.
    const snapshot = this.registry.getSnapshot(symbol);
    const orderInBook = new Map(snapshot.orders.map(o => [o.id, o]));

    // ── 7. Send Execution Reports ─────────────────────────────────────────
    for (const update of result.updates) {
      // Route to the session that owns this order (may differ from sessionId for resting side)
      const targetSession = this.orderManager.getSession(update.orderId) ?? sessionId;
      const fixStatus  = toFIXStatus(update.state);
      const execPrice  = execPrices.get(update.orderId) ?? 0;

      // Original qty: from snapshot if order is still resting; otherwise derive.
      const inBook = orderInBook.get(update.orderId);
      const originalQty = inBook
        ? inBook.quantity
        : update.state === 'Cancelled'
          ? qty                         // Market order ran out — submitted qty is the original
          : update.filledQuantity;      // Fully filled → filledQty equals the original qty

      // Terminal states leave zero quantity remaining.
      const isTerminal = update.state === 'Filled'
        || update.state === 'Cancelled'
        || update.state === 'Rejected';
      const leavesQty = isTerminal ? 0 : Math.max(0, originalQty - update.filledQuantity);

      const fields = new Map<number, string>([
        [TAG.MSG_TYPE,   '8'],
        [TAG.ORDER_ID,   update.orderId],
        [TAG.CL_ORD_ID, clOrdId],
        [TAG.EXEC_ID,    String(++this.execIdSeq)],
        [TAG.EXEC_TYPE,  fixStatus],
        [TAG.ORD_STATUS, fixStatus],
        [TAG.SYMBOL,     symbol],
        [TAG.SIDE,       sideRaw],
        [TAG.ORDER_QTY,  String(originalQty)],
        [TAG.CUM_QTY,    String(update.filledQuantity)],
        [TAG.LEAVES_QTY, String(leavesQty)],
        [TAG.AVG_PX,     String(execPrice)],
      ]);

      if (update.cancelReason) {
        fields.set(TAG.TEXT, update.cancelReason);
      }

      this.engine.sendMessage(targetSession, fields);
    }

    // ── 8. Publish market data events ─────────────────────────────────────
    this.publishOrderBookEvents(
      symbol, side, qty, orderType, price, account, trader,
      result, preBook, orderInBook,
    );
  }

  // ─── Private: SecurityListRequest handler ────────────────────────────────

  private handleSecurityListRequest(msg: IMessage): void {
    const sessionId = msg.sessionId;
    const reqId = msg.get(TAG.SECURITY_REQ_ID) ?? '';

    const instruments = this.registry.list();

    const header = new Map<number, string>([
      [TAG.MSG_TYPE,                'y'],
      [TAG.SECURITY_RESPONSE_ID,    String(++this.execIdSeq)],
      [TAG.SECURITY_REQ_ID,         reqId],
      [TAG.SECURITY_REQUEST_RESULT, '0'],          // 0 = Valid request
      [TAG.NO_RELATED_SYM,          String(instruments.length)],
    ]);

    const groups = instruments.map((instr) => new Map<number, string>([
      [TAG.SYMBOL,              instr.symbol],
      [TAG.SECURITY_DESC,       instr.name],
      [TAG.CURRENCY,            instr.currency],
      [TAG.CONTRACT_MULTIPLIER, String(instr.contractSize)],
      [TAG.MATURITY_DATE,       toFIXDate(instr.expiryDate)],
      [TAG.MIN_PRICE_INCREMENT, String(instr.tickSize)],
    ]));

    this.engine.sendGroupMessage(sessionId, header, groups);
  }

  // ─── Private: OrderCancelRequest handler ─────────────────────────────────

  private handleCancelRequest(msg: IMessage): void {
    const sessionId  = msg.sessionId;
    const clOrdId    = msg.get(TAG.CL_ORD_ID)      ?? '';
    const origClOrdId = msg.get(TAG.ORIG_CL_ORD_ID) ?? '';
    const orderId    = msg.get(TAG.ORDER_ID);
    const symbol     = msg.get(TAG.SYMBOL)          ?? '';
    const sideRaw    = msg.get(TAG.SIDE)            ?? '1';

    if (!orderId) {
      // Cannot identify the order without OrderID — reject immediately with 35=9.
      this.engine.sendMessage(sessionId, this.buildCancelReject({
        orderId: 'NONE', clOrdId, origClOrdId, symbol, sideRaw,
        ordStatus: '8', cancelReason: 'MissingOrderID',
      }));
      return;
    }

    // Pre-cancel snapshot: get the order's original and accumulated quantities while
    // it is still resting in the book (before we remove it via cancel).
    let originalQty = 0;
    let preSnapshotOrder: Order | undefined;
    if (symbol) {
      try {
        const snapshot = this.registry.getSnapshot(symbol);
        preSnapshotOrder = snapshot.orders.find(o => o.id === orderId);
        if (preSnapshotOrder) {
          originalQty = preSnapshotOrder.quantity;
        }
      } catch {
        // Symbol not found in registry — proceed without quantity info.
      }
    }

    const update = this.orderManager.cancel({ orderId }, sessionId);

    if (update.state !== 'Cancelled') {
      // Cancel was rejected — send 35=9 (OrderCancelReject).
      this.engine.sendMessage(sessionId, this.buildCancelReject({
        orderId,
        clOrdId,
        origClOrdId,
        symbol,
        sideRaw,
        ordStatus: toFIXStatus(update.state),
        cancelReason: update.cancelReason,
      }));
      return;
    }

    // Cancel succeeded — send 35=8 (ExecutionReport).
    this.engine.sendMessage(sessionId, this.buildCancelER({
      orderId,
      clOrdId,
      symbol,
      sideRaw,
      status: '4',
      cumQty: update.filledQuantity,
      originalQty,
    }));

    // Publish market data event for client-initiated cancels.
    if (preSnapshotOrder) {
      this.publisher.publish(symbol, {
        type: 'OrderCancelled',
        order: { ...preSnapshotOrder, state: 'Cancelled' },
      });
    }
  }

  // ─── Private: engine-initiated cancel ER (market close / expiry) ─────────

  private sendEngineInitiatedCancelER(symbol: string, info: ClosedOrderInfo): void {
    const sideRaw = info.side === 'Buy' ? '1' : '2';
    this.engine.sendMessage(info.sessionId, this.buildCancelER({
      orderId: info.orderId,
      clOrdId: '',   // no cancel-request ClOrdID for engine-initiated cancels
      symbol,
      sideRaw,
      status: '4',   // Cancelled
      cumQty: info.update.filledQuantity,
      originalQty: info.originalQty,
    }));
  }

  // ─── Private: successful cancel ER (35=8) ────────────────────────────────

  private buildCancelER(opts: {
    orderId: string;
    clOrdId: string;
    symbol: string;
    sideRaw: string;
    status: string;
    cumQty: number;
    originalQty: number;
  }): Map<number, string> {
    return new Map<number, string>([
      [TAG.MSG_TYPE,   '8'],
      [TAG.ORDER_ID,   opts.orderId],
      [TAG.CL_ORD_ID, opts.clOrdId],
      [TAG.EXEC_ID,    String(++this.execIdSeq)],
      [TAG.EXEC_TYPE,  opts.status],
      [TAG.ORD_STATUS, opts.status],
      [TAG.SYMBOL,     opts.symbol],
      [TAG.SIDE,       opts.sideRaw],
      [TAG.ORDER_QTY,  String(opts.originalQty)],
      [TAG.CUM_QTY,    String(opts.cumQty)],
      [TAG.LEAVES_QTY, '0'],
      [TAG.AVG_PX,     '0'],
    ]);
  }

  // ─── Private: cancel reject (35=9) ───────────────────────────────────────

  private buildCancelReject(opts: {
    orderId: string;
    clOrdId: string;
    origClOrdId: string;
    symbol: string;
    sideRaw: string;
    ordStatus: string;
    cancelReason?: string;
  }): Map<number, string> {
    const fields = new Map<number, string>([
      [TAG.MSG_TYPE,        '9'],
      [TAG.ORDER_ID,        opts.orderId],
      [TAG.CL_ORD_ID,       opts.clOrdId],
      [TAG.ORIG_CL_ORD_ID,  opts.origClOrdId],
      [TAG.ORD_STATUS,      opts.ordStatus],
      [TAG.CXL_REJ_REASON,  toCxlRejReason(opts.cancelReason)],
      [TAG.SYMBOL,          opts.symbol],
      [TAG.SIDE,            opts.sideRaw],
    ]);
    if (opts.cancelReason) {
      fields.set(TAG.TEXT, opts.cancelReason);
    }
    return fields;
  }

  // ─── Private: MarketDataRequest handler ─────────────────────────────────

  private handleMarketDataRequest(msg: IMessage): void {
    const sessionId      = msg.sessionId;
    const reqId          = msg.get(TAG.MD_REQ_ID) ?? '';
    const subReqType     = msg.get(TAG.SUBSCRIPTION_REQ_TYPE) ?? '0';
    const symbol         = msg.get(TAG.SYMBOL) ?? '';

    if (subReqType === '2') {
      // Unsubscribe
      this.publisher.unsubscribe(sessionId, symbol);
      return;
    }

    if (!this.registry.get(symbol)) {
      this.engine.sendMessage(sessionId, new Map<number, string>([
        [TAG.MSG_TYPE,          'Y'],
        [TAG.MD_REQ_ID,         reqId],
        [TAG.MD_REQ_REJ_REASON, '0'], // Unknown symbol
        [TAG.TEXT,              `Unknown symbol: ${symbol}`],
      ]));
      return;
    }

    // Snapshot or Subscribe — both start with sending the current snapshot.
    const snapshot = this.publisher.subscribe(sessionId, symbol, (event) => {
      this.sendIncrementalRefresh(sessionId, reqId, symbol, event);
    });

    // Send snapshot W
    this.sendSnapshotFullRefresh(sessionId, reqId, symbol, snapshot.orders);

    // Snapshot-only: immediately remove the subscription after sending W.
    if (subReqType === '0') {
      this.publisher.unsubscribe(sessionId, symbol);
    }
  }

  // ─── Private: market data event publisher (called from handleNewOrder) ───

  private publishOrderBookEvents(
    symbol: string,
    side: Side,
    qty: number,
    orderType: OrderType,
    price: number | undefined,
    account: string,
    trader: string,
    result: SubmitResult,
    preBook: Map<string, Order>,
    postBook: Map<string, Order>,
  ): void {
    // Trade events first — these don't depend on order state.
    for (const trade of result.trades) {
      this.publisher.publish(symbol, { trade });
    }

    if (result.updates.length === 0) return;

    // The aggressor's update is always last in the result (OrderBook invariant).
    const aggressorId = result.updates.at(-1)!.orderId;

    for (const update of result.updates) {
      if (update.state === 'Rejected') continue;

      // Build the full Order object for this update.
      const inPost = postBook.get(update.orderId); // still resting after the trade
      const inPre  = preBook.get(update.orderId);  // was resting before the trade

      let order: Order;
      if (inPost) {
        order = inPost;
      } else if (inPre) {
        // Resting order consumed by trade — reconstruct with updated state.
        order = { ...inPre, state: update.state, filledQuantity: update.filledQuantity };
      } else {
        // Aggressor's own order (not in either snapshot).
        order = {
          id: aggressorId,
          symbol, side, type: orderType,
          quantity: qty, price,
          account, trader,
          state: update.state,
          filledQuantity: update.filledQuantity,
          timestamp: 0,
        };
      }

      // Map order state to OrderBookEventType.
      let eventType: OrderBookEventType;
      if (update.state === 'New') {
        eventType = 'OrderAdded';
      } else if (update.state === 'PartiallyFilled') {
        // Resting side hit: was in preBook → PartiallyFilled (change to existing entry).
        // Aggressor side: crossed partially, now rests as a new entry → OrderAdded.
        eventType = inPre !== undefined ? 'OrderPartiallyFilled' : 'OrderAdded';
      } else if (update.state === 'Filled') {
        eventType = 'OrderFilled';
      } else {
        eventType = 'OrderCancelled';
      }

      this.publisher.publish(symbol, { type: eventType, order });
    }
  }

  // ─── Private: MarketDataSnapshotFullRefresh (35=W) ───────────────────────

  private sendSnapshotFullRefresh(
    sessionId: string,
    reqId: string,
    symbol: string,
    orders: Order[],
  ): void {
    const header = new Map<number, string>([
      [TAG.MSG_TYPE,    'W'],
      [TAG.MD_REQ_ID,   reqId],
      [TAG.SYMBOL,      symbol],
      [TAG.NO_MD_ENTRIES, String(orders.length)],
    ]);

    const groups = orders.map(order => {
      const remainingQty = order.quantity - order.filledQuantity;
      return new Map<number, string>([
        [TAG.MD_ENTRY_TYPE, order.side === 'Buy' ? '0' : '1'],
        [TAG.MD_ENTRY_ID,   order.id],
        [TAG.MD_ENTRY_PX,   String(order.price ?? 0)],
        [TAG.MD_ENTRY_SIZE, String(remainingQty)],
      ]);
    });

    this.engine.sendGroupMessage(sessionId, header, groups);
  }

  // ─── Private: MarketDataIncrementalRefresh (35=X) ────────────────────────

  private sendIncrementalRefresh(
    sessionId: string,
    reqId: string,
    symbol: string,
    event: import('@matchingengine/engine').MarketDataEvent,
  ): void {
    const header = new Map<number, string>([
      [TAG.MSG_TYPE,      'X'],
      [TAG.MD_REQ_ID,     reqId],
      [TAG.NO_MD_ENTRIES, '1'],
    ]);

    let group: Map<number, string>;

    if ('trade' in event) {
      // Trade event
      group = new Map<number, string>([
        [TAG.MD_UPDATE_ACTION, '0'],   // New
        [TAG.MD_ENTRY_TYPE,    '2'],   // Trade
        [TAG.SYMBOL,           symbol],
        [TAG.MD_ENTRY_PX,      String(event.trade.price)],
        [TAG.MD_ENTRY_SIZE,    String(event.trade.quantity)],
      ]);
    } else {
      // OrderBookEvent
      const { type, order } = event;
      const action = type === 'OrderAdded'     ? '0'
                   : type === 'OrderPartiallyFilled' ? '1'
                   : '2'; // Filled or Cancelled → Delete
      const entryType = order.side === 'Buy' ? '0' : '1';
      const remainingQty = (type === 'OrderFilled' || type === 'OrderCancelled')
        ? 0
        : order.quantity - order.filledQuantity;

      group = new Map<number, string>([
        [TAG.MD_UPDATE_ACTION, action],
        [TAG.MD_ENTRY_TYPE,    entryType],
        [TAG.SYMBOL,           symbol],
        [TAG.MD_ENTRY_ID,      order.id],
        [TAG.MD_ENTRY_PX,      String(order.price ?? 0)],
        [TAG.MD_ENTRY_SIZE,    String(remainingQty)],
      ]);
    }

    this.engine.sendGroupMessage(sessionId, header, [group]);
  }

  // ─── Private: rejected Execution Report (pre-Engine validation) ──────────

  private sendRejectER(
    sessionId: string,
    opts: { clOrdId: string; symbol: string; sideRaw: string; qty: number; reason: string },
  ): void {
    this.engine.sendMessage(sessionId, new Map<number, string>([
      [TAG.MSG_TYPE,      '8'],
      [TAG.ORDER_ID,      'NONE'],
      [TAG.CL_ORD_ID,     opts.clOrdId],
      [TAG.EXEC_ID,       String(++this.execIdSeq)],
      [TAG.EXEC_TYPE,     '8'],
      [TAG.ORD_STATUS,    '8'],
      [TAG.SYMBOL,        opts.symbol],
      [TAG.SIDE,          opts.sideRaw],
      [TAG.ORDER_QTY,     String(opts.qty)],
      [TAG.CUM_QTY,       '0'],
      [TAG.LEAVES_QTY,    '0'],
      [TAG.AVG_PX,        '0'],
      [TAG.ORD_REJ_REASON, toOrdRejReason(opts.reason)],
      [TAG.TEXT,          opts.reason],
    ]));
  }
}
