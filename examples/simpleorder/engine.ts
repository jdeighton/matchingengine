/**
 * examples/simpleorder/engine.ts
 *
 * Matching engine server for the simple-order example.
 *
 *   - Lists ESU6 (E-mini S&P 500 Sep 2026) and opens the market.
 *   - Accepts FIX 4.4 connections from:
 *       FUND-A  on port 9001
 *       FUND-B  on port 9002
 *   - Logs session events, order book changes, and trades as they happen.
 *   - Prints an order book recap 200 ms after each burst of events.
 *
 * Start this script first, then run fund-a.ts and fund-b.ts in separate
 * terminal windows.
 *
 *   npm run build          # build all workspace packages first
 *   npx tsx examples/simpleorder/engine.ts
 */

import { Engine } from '@fixenginelib/core';
import { InstrumentRegistry, OrderManager, MarketDataPublisher } from '@matchingengine/engine';
import { Gateway } from '@matchingengine/gateway';
import type { IFixEngine } from '@matchingengine/gateway';

// ─── ANSI colour helpers ──────────────────────────────────────────────────────

const R      = '\x1b[0m';
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';

function ts(): string { return new Date().toISOString().slice(11, 23); }

function log(color: string, label: string, msg: string): void {
  console.log(`${DIM}${ts()}${R}  ${color}${BOLD}[${label}]${R}  ${msg}`);
}

// ─── Instrument & matching-engine setup ───────────────────────────────────────

const registry  = new InstrumentRegistry();
const orderMgr  = new OrderManager(registry);
const publisher = new MarketDataPublisher(registry);

registry.add({
  symbol:        'ESU6',
  name:          'E-mini S&P 500 Sep 2026',
  tickSize:      0.25,
  contractSize:  50,
  currency:      'USD',
  expiryDate:    new Date('2026-09-18'),
});

registry.setMarketState('ESU6', 'Open');
log(CYAN, 'ENGINE', 'ESU6 market opened');

// ─── Order book recap (debounced 200 ms after last market-data event) ─────────

let bookTimer: ReturnType<typeof setTimeout> | undefined;

function scheduleBookPrint(): void {
  clearTimeout(bookTimer);
  bookTimer = setTimeout(printBook, 200);
}

function printBook(): void {
  const { orders } = registry.getSnapshot('ESU6');

  const bids = orders
    .filter((o) => o.side === 'Buy')
    .sort((a, b) => (b.price ?? 0) - (a.price ?? 0));

  const asks = orders
    .filter((o) => o.side === 'Sell')
    .sort((a, b) => (a.price ?? 0) - (b.price ?? 0));

  const W   = 34;
  const bar = '═'.repeat(W);
  console.log(`\n${BOLD}  ╔${bar}╗`);
  console.log(`  ║${'  Order Book: ESU6'.padEnd(W)}║${R}`);
  console.log(`${BOLD}  ╠${bar}╣${R}`);

  if (asks.length === 0 && bids.length === 0) {
    console.log(`  ${DIM}    (empty)${R}`);
  } else {
    // Asks: show lowest first (most aggressive ask at the bottom, nearest to spread)
    for (const a of [...asks].reverse()) {
      const rem = a.quantity - a.filledQuantity;
      console.log(`  ${RED}    ASK  ${String(rem).padStart(6)} @ ${a.price}${R}`);
    }
    if (asks.length > 0 && bids.length > 0) {
      console.log(`  ${DIM}    ${'─'.repeat(W - 4)}${R}`);
    }
    for (const b of bids) {
      const rem = b.quantity - b.filledQuantity;
      console.log(`  ${GREEN}    BID  ${String(rem).padStart(6)} @ ${b.price}${R}`);
    }
  }

  console.log(`${BOLD}  ╚${bar}╝${R}\n`);
}

// ─── Market data event logging ─────────────────────────────────────────────────

// Subscribe with a synthetic session ID so the publisher routes events to us.
publisher.subscribe('__LOGGER__', 'ESU6', (event) => {
  if ('trade' in event) {
    const { trade } = event;
    log(YELLOW, 'TRADE', `${trade.quantity} ESU6 @ ${trade.price}`);
  } else {
    const { type, order } = event;
    const sideStr  = order.side === 'Buy' ? `${GREEN}BUY${R}` : `${RED}SELL${R}`;
    const rem      = order.quantity - order.filledQuantity;
    const priceStr = order.price != null ? String(order.price) : 'MKT';
    log(YELLOW, 'BOOK ', `${type}: ${sideStr} ${order.quantity} ESU6 @ ${priceStr}  (remaining: ${rem})`);
  }
  scheduleBookPrint();
});

// ─── FIX engine ───────────────────────────────────────────────────────────────

//
// The real Engine satisfies IFixEngine structurally EXCEPT for sendGroupMessage,
// which is used only for SecurityList (35=y) and MarketDataSnapshot (35=W/X).
// This example demonstrates order routing only (NewOrderSingle → ExecutionReport),
// so sendGroupMessage is never called.  We add a no-op stub to satisfy the type.
//
const fixEngine  = new Engine([]);
const engineView = Object.assign(fixEngine, {
  sendGroupMessage(
    _sessionId: string,
    _header:    Map<number, string>,
    _groups:    Map<number, string>[],
  ): void {
    // Not used in this example.
  },
}) as unknown as IFixEngine;

// ─── Gateway ──────────────────────────────────────────────────────────────────

// Use an in-memory sequence-number store so every run starts fresh at seq 1.
const freshStore = { load: async () => ({ outSeqNum: 1, inSeqNum: 1 }), save: async () => {} };

const gateway = new Gateway(engineView, orderMgr, publisher, registry);

gateway.start([
  {
    mode:                  'server',
    senderCompId:          'EXCHANGE',
    targetCompId:          'FUND-A',
    port:                  9001,
    beginString:           'FIX.4.4',
    heartbeatIntervalSecs: 30,
    logDir:                './logs/engine',
    store:                 freshStore,
  },
  {
    mode:                  'server',
    senderCompId:          'EXCHANGE',
    targetCompId:          'FUND-B',
    port:                  9002,
    beginString:           'FIX.4.4',
    heartbeatIntervalSecs: 30,
    logDir:                './logs/engine',
    store:                 freshStore,
  },
]);

// Attach session status loggers.  Sessions are added by gateway.start() so they
// are available immediately after the call returns.
for (const [sessionId, label] of [
  ['EXCHANGE-FUND-A-FIX.4.4', 'FUND-A'],
  ['EXCHANGE-FUND-B-FIX.4.4', 'FUND-B'],
] as [string, string][]) {
  const session = fixEngine.getSession(sessionId);
  if (session) {
    session.on('status', (status: string) => {
      const c = status === 'active' ? GREEN : DIM;
      log(c, label, `session ${status}`);
    });
  }
}

log(CYAN, 'ENGINE', 'Listening — FUND-A on :9001, FUND-B on :9002');
log(CYAN, 'ENGINE', 'Press Ctrl-C to stop.\n');

// ─── Graceful shutdown ────────────────────────────────────────────────────────

process.on('SIGINT', () => {
  log(CYAN, 'ENGINE', 'Shutting down...');
  void gateway.stop().then(() => process.exit(0));
});
