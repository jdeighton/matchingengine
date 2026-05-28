# Simple Order Example

A minimal end-to-end demonstration of the matching engine using real **FIX 4.4 TCP connections**.

Three independent processes run simultaneously — the matching engine and two client firms — exactly as they would in production.

---

## Scenario

| Step | Actor  | Action                           | Result                                            |
|------|--------|----------------------------------|---------------------------------------------------|
| 1    | Engine | Opens ESU6 market                | Market state: Open                                |
| 2    | FUND-A | Limit buy — 50 ESU6 @ 7358.25   | No opposing orders → order rests in the book      |
| 3    | FUND-B | Limit sell — 30 ESU6 @ 7358.00  | Crosses resting bid → 30 lots trade at **7358.25** |
| —    | —      | —                                | 20-lot remainder for FUND-A stays resting         |

**Why 7358.25 and not 7358.00?**  
Trades execute at the *resting* order's price (price-time priority). FUND-A placed its bid first at 7358.25; FUND-B's ask at 7358.00 is willing to accept any price ≥ 7358.00, so the fill is at the better resting price.

---

## Instrument: ESU6

| Field         | Value                     |
|---------------|---------------------------|
| Symbol        | `ESU6`                    |
| Name          | E-mini S&P 500 Sep 2026   |
| Tick size     | 0.25                      |
| Contract size | 50                        |
| Currency      | USD                       |
| Expiry        | 2026-09-18                |

---

## Prerequisites

Install dependencies and build all workspace packages **from the repo root**:

```sh
npm install
npm run build
```

---

## Running the example

Open **three terminal windows**, each in the repo root (`D:\NextCloud\src\matchingengine` or wherever you have it checked out).

### Terminal 1 — Matching Engine

```sh
npx tsx examples/simpleorder/engine.ts
```

Wait until you see:

```
[ENGINE]  ESU6 market opened
[ENGINE]  Listening — FUND-A on :9001, FUND-B on :9002
```

### Terminal 2 — FUND-A

```sh
npx tsx examples/simpleorder/fund-a.ts
```

FUND-A connects, sends a limit buy, and waits for fills.  
The engine terminal shows the order appearing in the book.

Wait until FUND-A prints:

```
Order is resting in the book.  leavesQty=50
Waiting for a fill... (start fund-b.ts in another terminal)
```

### Terminal 3 — FUND-B

```sh
npx tsx examples/simpleorder/fund-b.ts
```

FUND-B connects and sends a limit sell. The sell crosses FUND-A's resting bid immediately.

---

## Expected output

### Engine terminal

```
10:00:00.001  [ENGINE]  ESU6 market opened
10:00:00.002  [ENGINE]  Listening — FUND-A on :9001, FUND-B on :9002

10:00:05.120  [FUND-A]  session connecting
10:00:05.135  [FUND-A]  session active

10:00:05.140  [BOOK ]   OrderAdded: BUY 50 ESU6 @ 7358.25  (remaining: 50)

  ╔══════════════════════════════════════╗
  ║  Order Book: ESU6                    ║
  ╠══════════════════════════════════════╣
    BID       50 @ 7358.25
  ╚══════════════════════════════════════╝

10:00:20.300  [FUND-B]  session connecting
10:00:20.315  [FUND-B]  session active

10:00:20.320  [TRADE]   30 ESU6 @ 7358.25
10:00:20.321  [BOOK ]   OrderPartiallyFilled: BUY 50 ESU6 @ 7358.25  (remaining: 20)
10:00:20.322  [BOOK ]   OrderFilled: SELL 30 ESU6 @ 7358.00  (remaining: 0)

  ╔══════════════════════════════════════╗
  ║  Order Book: ESU6                    ║
  ╠══════════════════════════════════════╣
    BID       20 @ 7358.25
  ╚══════════════════════════════════════╝
```

### FUND-A terminal

```
[CYAN]   Session: connecting
[CYAN]   Session: logon_sent
[CYAN]   Session: active
[GREEN]  Sending NewOrderSingle — Buy 50 ESU6 @ 7358.25
[GREEN]  ExecReport: New  orderId=<uuid>
[GREEN]  Order is resting in the book.  leavesQty=50
[DIM]    Waiting for a fill... (start fund-b.ts in another terminal)

... (FUND-B runs) ...

[YELLOW] ExecReport: PartiallyFilled  orderId=<uuid>
[YELLOW] Partial fill: 30 lots traded @ avgPx 7358.25.  20 lots remain.
[DIM]    The remaining 20 lots are still resting in the engine.
```

### FUND-B terminal

```
[CYAN]   Session: connecting
[CYAN]   Session: logon_sent
[CYAN]   Session: active
[RED]    Sending NewOrderSingle — Sell 30 ESU6 @ 7358.00
[GREEN]  ExecReport: Filled  orderId=<uuid>
[GREEN]  Order fully filled: 30 lots @ avgPx 7358.25
[YELLOW] Trade executed at the resting bid price (7358.25) — price-time priority.
```

---

## Ports used

| Session                | Port |
|------------------------|------|
| Engine ↔ FUND-A        | 9001 |
| Engine ↔ FUND-B        | 9002 |

---

## FIX session IDs

Formed as `SenderCompID-TargetCompID-BeginString`:

| Process      | Session ID                     |
|--------------|-------------------------------|
| Engine/FUND-A side | `EXCHANGE-FUND-A-FIX.4.4`  |
| Engine/FUND-B side | `EXCHANGE-FUND-B-FIX.4.4`  |
| FUND-A client      | `FUND-A-EXCHANGE-FIX.4.4`  |
| FUND-B client      | `FUND-B-EXCHANGE-FIX.4.4`  |

---

## Logs

Raw FIX message logs are written under `./logs/` in the repo root:

```
logs/
├── engine/    ← server-side sessions (EXCHANGE↔FUND-A, EXCHANGE↔FUND-B)
├── fund-a/    ← FUND-A client session
└── fund-b/    ← FUND-B client session
```

Sequence numbers are held in memory (not persisted), so each run starts fresh at sequence 1. This keeps the demo self-contained and avoids stale sequence files causing Logout on reconnect.

---

## Stopping

Press **Ctrl-C** in each terminal window.

Stopping a client sends a FIX Logout to the engine, which gracefully closes the session. For the cleanest shutdown, stop FUND-A and FUND-B before the engine.
