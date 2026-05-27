import type { IFixEngine, IFixSession, IMessage, SessionConfig } from './fix-engine.js';
import type { OrderManager, MarketDataPublisher, InstrumentRegistry } from '@matchingengine/engine';
import type { OrderState, Side, Trade } from '@matchingengine/shared-types';

// ─── FIX field constants ──────────────────────────────────────────────────────

const TAG = {
  MSG_TYPE:      35,
  CL_ORD_ID:    11,
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

function isOnTick(price: number, tickSize: number): boolean {
  const ratio = price / tickSize;
  return Math.abs(ratio - Math.round(ratio)) < 1e-9;
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
  private execIdSeq = 0;

  constructor(
    private readonly engine: IFixEngine,
    private readonly orderManager: OrderManager,
    private readonly publisher: MarketDataPublisher,
    private readonly registry: InstrumentRegistry,
  ) {}

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

  addSession(config: SessionConfig): void {
    const session = this.engine.addSession(config);
    this.watchSession(session);
  }

  async removeSession(sessionId: string): Promise<void> {
    const session = this.engine.getSession(sessionId);
    const handler = this.handlers.get(sessionId);
    if (session && handler) {
      session.off('status', handler);
      this.handlers.delete(sessionId);
    }
    await this.engine.removeSession(sessionId);
  }

  // ─── Message handling (public so tests can drive it directly) ────────────

  handleMessage(msg: IMessage): void {
    const msgType = msg.get(TAG.MSG_TYPE);
    if (msgType === 'D') this.handleNewOrder(msg);
  }

  // ─── Private: session watcher ────────────────────────────────────────────

  private watchSession(session: IFixSession): void {
    const handler = (status: string) => {
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

    const result = this.orderManager.place(
      { symbol, side, type: isLimit ? 'Limit' : 'Market', quantity: qty, price, account, trader },
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
  }

  // ─── Private: rejected Execution Report (pre-Engine validation) ──────────

  private sendRejectER(
    sessionId: string,
    opts: { clOrdId: string; symbol: string; sideRaw: string; qty: number; reason: string },
  ): void {
    this.engine.sendMessage(sessionId, new Map<number, string>([
      [TAG.MSG_TYPE,   '8'],
      [TAG.ORDER_ID,   'NONE'],
      [TAG.CL_ORD_ID, opts.clOrdId],
      [TAG.EXEC_ID,    String(++this.execIdSeq)],
      [TAG.EXEC_TYPE,  '8'],
      [TAG.ORD_STATUS, '8'],
      [TAG.SYMBOL,     opts.symbol],
      [TAG.SIDE,       opts.sideRaw],
      [TAG.ORDER_QTY,  String(opts.qty)],
      [TAG.CUM_QTY,    '0'],
      [TAG.LEAVES_QTY, '0'],
      [TAG.AVG_PX,     '0'],
      [TAG.TEXT,       opts.reason],
    ]));
  }
}
