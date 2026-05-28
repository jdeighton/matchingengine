/**
 * examples/simpleorder/fund-b.ts
 *
 * FIX client for FUND-B — sends a limit sell order for 30 lots of ESU6 @ 7358.00.
 *
 * Run AFTER engine.ts AND fund-a.ts have started, and FUND-A's order is resting:
 *   npx tsx examples/simpleorder/fund-b.ts
 *
 * Expected flow:
 *   1. Connects to the matching engine on port 9002 and completes FIX logon.
 *   2. Sends:  NewOrderSingle — Sell 30 ESU6 @ 7358.00
 *   3. FUND-A's resting bid at 7358.25 crosses FUND-B's ask at 7358.00.
 *      The trade executes at the resting order's price: 7358.25.
 *   4. FUND-B receives: ExecReport (Filled) — 30 lots @ 7358.25.
 *      FUND-A receives: ExecReport (PartiallyFilled) — 30 filled, 20 remain.
 *   5. Exits.
 */

import { Engine } from '@fixenginelib/core';
import type { Message } from '@fixenginelib/core';

// ─── ANSI colour helpers ──────────────────────────────────────────────────────

const R      = '\x1b[0m';
const DIM    = '\x1b[2m';
const BOLD   = '\x1b[1m';
const GREEN  = '\x1b[32m';
const RED    = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN   = '\x1b[36m';

function ts(): string { return new Date().toISOString().slice(11, 23); }
function log(color: string, msg: string): void {
  console.log(`${DIM}${ts()}${R}  ${color}${msg}${R}`);
}

// ─── FIX engine (client mode) ─────────────────────────────────────────────────

const SESSION_ID = 'FUND-B-EXCHANGE-FIX.4.4';

const engine = new Engine([{
  mode:                  'client',
  host:                  '127.0.0.1',
  port:                  9002,
  senderCompId:          'FUND-B',
  targetCompId:          'EXCHANGE',
  beginString:           'FIX.4.4',
  heartbeatIntervalSecs: 30,
  logDir:                './logs/fund-b',
  // In-memory store: fresh sequence numbers on every run.
  store: { load: async () => ({ outSeqNum: 1, inSeqNum: 1 }), save: async () => {} },
}]);

// ─── Session status handler ───────────────────────────────────────────────────

const session = engine.getSessions()[0];
let orderSent = false;

session.on('status', (status: string) => {
  log(CYAN, `Session: ${status}`);
  if (status === 'active' && !orderSent) {
    orderSent = true;
    sendSellOrder();
  }
});

// ─── Start engine (initiates TCP connect + FIX logon) ────────────────────────

engine.start();

// ─── Execution report handler ─────────────────────────────────────────────────

function statusLabel(code: string): string {
  switch (code) {
    case '0': return 'New';
    case '1': return 'PartiallyFilled';
    case '2': return 'Filled';
    case '4': return 'Cancelled';
    case '8': return 'Rejected';
    default:  return code;
  }
}

(async () => {
  for await (const raw of engine.messages()) {
    const msg = raw as Message;
    if (msg.get(35) !== '8') continue; // Only handle ExecutionReports

    const status    = msg.get(39)  ?? '?';
    const orderId   = msg.get(37)  ?? '?';
    const cumQty    = msg.get(14)  ?? '0';
    const leavesQty = msg.get(151) ?? '0';
    const avgPx     = msg.get(6)   ?? '0';
    const text      = msg.get(58);
    const label     = statusLabel(status);

    switch (status) {
      case '0': // New — order resting (no opposing liquidity; shouldn't occur in this scenario)
        log(YELLOW, `${BOLD}ExecReport: ${label}${R}  orderId=${orderId}`);
        log(YELLOW, `Order is resting. cumQty=${cumQty}, leavesQty=${leavesQty}`);
        log(DIM,    'Hint: is FUND-A connected and its buy order resting?');
        break;

      case '1': // PartiallyFilled
        log(YELLOW, `${BOLD}ExecReport: ${label}${R}  orderId=${orderId}`);
        log(YELLOW, `Partial fill: ${cumQty} lots @ avgPx ${avgPx}.  ${leavesQty} lots remain.`);
        break;

      case '2': // Filled
        log(GREEN, `${BOLD}ExecReport: ${label}${R}  orderId=${orderId}`);
        log(GREEN, `${BOLD}Order fully filled: ${cumQty} lots @ avgPx ${avgPx}${R}`);
        log(YELLOW, 'Trade executed at the resting bid price (7358.25) — price-time priority.');
        // Demo complete for FUND-B — exit cleanly.
        void engine.stop().then(() => process.exit(0));
        break;

      case '4': // Cancelled
        log(RED, `${BOLD}ExecReport: ${label}${R}  orderId=${orderId}${text ? `  (${text})` : ''}`);
        void engine.stop().then(() => process.exit(0));
        break;

      case '8': // Rejected
        log(RED, `${BOLD}ExecReport: ${label}${R}  orderId=${orderId}${text ? `  (${text})` : ''}`);
        log(RED, 'Order rejected.');
        void engine.stop().then(() => process.exit(1));
        break;
    }
  }
})();

// ─── Order builder ────────────────────────────────────────────────────────────

function sendSellOrder(): void {
  log(RED, `${BOLD}Sending NewOrderSingle — Sell 30 ESU6 @ 7358.00${R}`);
  engine.sendMessage(SESSION_ID, new Map<number, string>([
    [35, 'D'],            // MsgType: NewOrderSingle
    [11, 'FUNDB-001'],    // ClOrdID
    [1,  'ACC-FUND-B'],   // Account
    [50, 'TRADER-B'],     // SenderSubID (trader name used by the matching engine)
    [55, 'ESU6'],         // Symbol
    [54, '2'],            // Side: 2 = Sell
    [40, '2'],            // OrdType: 2 = Limit
    [38, '30'],           // OrderQty
    [44, '7358.00'],      // Price
  ]));
}

// ─── Graceful shutdown on Ctrl-C ─────────────────────────────────────────────

process.on('SIGINT', () => {
  log(CYAN, 'FUND-B disconnecting...');
  void engine.stop().then(() => process.exit(0));
});
