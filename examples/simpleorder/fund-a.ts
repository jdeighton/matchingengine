/**
 * examples/simpleorder/fund-a.ts
 *
 * FIX client for FUND-A — sends a limit buy order for 50 lots of ESU6 @ 7358.25.
 *
 * Run AFTER engine.ts is already listening:
 *   npx tsx examples/simpleorder/fund-a.ts
 *
 * Expected flow:
 *   1. Connects to the matching engine on port 9001 and completes FIX logon.
 *   2. Sends:  NewOrderSingle — Buy 50 ESU6 @ 7358.25
 *   3. Receives: ExecReport (New) — order acknowledged, resting in the book.
 *   4. Waits; receives ExecReport (PartiallyFilled) once fund-b.ts runs and its
 *      sell order crosses the resting bid.
 *      → 30 lots trade at 7358.25 (resting price); 20 lots remain working.
 *   5. Exits, leaving the 20-lot remainder resting in the engine.
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

const SESSION_ID = 'FUND-A-EXCHANGE-FIX.4.4';

const engine = new Engine([{
  mode:                  'client',
  host:                  '127.0.0.1',
  port:                  9001,
  senderCompId:          'FUND-A',
  targetCompId:          'EXCHANGE',
  beginString:           'FIX.4.4',
  heartbeatIntervalSecs: 30,
  logDir:                './logs/fund-a',
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
    sendBuyOrder();
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
      case '0': // New — order resting in book
        log(GREEN, `${BOLD}ExecReport: ${label}${R}  orderId=${orderId}`);
        log(GREEN, `Order is resting in the book.  leavesQty=${leavesQty}`);
        log(DIM,   'Waiting for a fill... (start fund-b.ts in another terminal)');
        break;

      case '1': // PartiallyFilled
        log(YELLOW, `${BOLD}ExecReport: ${label}${R}  orderId=${orderId}`);
        log(YELLOW, `Partial fill: ${cumQty} lots traded @ avgPx ${avgPx}.  ${leavesQty} lots remain.`);
        log(DIM,    `The remaining ${leavesQty} lots are still resting in the engine.`);
        // Demo complete for FUND-A — exit cleanly.
        void engine.stop().then(() => process.exit(0));
        break;

      case '2': // Filled
        log(GREEN, `${BOLD}ExecReport: ${label}${R}  orderId=${orderId}`);
        log(GREEN, `Order fully filled: ${cumQty} lots @ avgPx ${avgPx}.`);
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

function sendBuyOrder(): void {
  log(GREEN, `${BOLD}Sending NewOrderSingle — Buy 50 ESU6 @ 7358.25${R}`);
  engine.sendMessage(SESSION_ID, new Map<number, string>([
    [35, 'D'],            // MsgType: NewOrderSingle
    [11, 'FUNDA-001'],    // ClOrdID
    [1,  'ACC-FUND-A'],   // Account
    [50, 'TRADER-A'],     // SenderSubID (trader name used by the matching engine)
    [55, 'ESU6'],         // Symbol
    [54, '1'],            // Side: 1 = Buy
    [40, '2'],            // OrdType: 2 = Limit
    [38, '50'],           // OrderQty
    [44, '7358.25'],      // Price
  ]));
}

// ─── Graceful shutdown on Ctrl-C ─────────────────────────────────────────────

process.on('SIGINT', () => {
  log(CYAN, 'FUND-A disconnecting...');
  void engine.stop().then(() => process.exit(0));
});
