# PRD: MatchingEngine v1

> Source: GitHub issue [#1](https://github.com/jdeighton/matchingengine/issues/1)

## Problem Statement

As a trading tool developer, I need a controllable, observable electronic trading platform to test my tools against. Existing production exchange connections are unsuitable for development and testing — they are live environments with real financial consequences, unpredictable behaviour, and no ability to manipulate market conditions on demand. I need a platform where I control the instruments, the market state, and the connectivity, so I can observe exactly how my tools behave under known conditions.

## Solution

Build **MatchingEngine** — an internal electronic trading platform written in Node.js/TypeScript. It exposes a FIX 4.4 interface to clients, supports multiple futures-style Instruments, matches orders using FIFO price/time priority, publishes order-by-order Market Data, and provides a web-based Admin Portal for controlling every aspect of the system. Controllability and observability are primary goals; performance is not.

The system comprises three components:
- **Engine** — the matching core, owning Order Books, Market State, and Market Data publication
- **Gateway** — the FIX 4.4 boundary, built on the `fixserver` library, handling validation and message translation
- **Admin Portal** — a Fastify + React + Vite web UI for managing Instruments, Market State, and FIX Session connectivity

## User Stories

### Reference Data

1. As a FIX client, I want to request Reference Data, so that I can discover all available Instruments and their properties (Symbol, name, tick size, contract size, currency, expiry date) before trading.
2. As a FIX client, I want Reference Data delivered as a single response message, so that I receive a complete and consistent view of available Instruments at a point in time.

### Order Entry

3. As a FIX client, I want to submit a New Order with type Market, so that my order executes immediately against the best available resting liquidity.
4. As a FIX client, I want to submit a New Order with type Limit, so that my order rests in the Order Book at my specified price if it cannot be immediately matched.
5. As a FIX client, I want to receive an Execution Report acknowledging my New Order, so that I know the Engine has accepted it.
6. As a FIX client, I want to receive an Execution Report with state `Rejected` if my New Order fails Gateway validation (unknown Symbol, missing Account or Trader, off-tick price), so that I know why the order was refused before it reached the Engine.
7. As a FIX client, I want to receive an Execution Report with state `Rejected` if I submit a New Order when the target Instrument is `Closed` or `Halted`, so that I receive immediate feedback rather than a silent failure.
8. As a FIX client, I want to submit a Cancellation Request for a resting Order, so that I can remove it from the Order Book.
9. As a FIX client, I want my Cancellation Request refused if I attempt to cancel an Order submitted by a different Session, so that I cannot interfere with another client's orders.
10. As a FIX client, I want to receive an Execution Report confirming my Order was cancelled, so that I know it is no longer resting in the book.
11. As a FIX client, I want to receive an Execution Report when my market Order's remainder is cancelled due to insufficient liquidity, so that I know the unfilled quantity was removed and understand why.

### Matching

12. As a FIX client, I want to receive fill Execution Reports when my Order is matched, including the execution price and quantity, so that I know trades have occurred against my Order.
13. As a FIX client, I want partial fill Execution Reports when my Order is only partially matched, so that I know the filled quantity and that my residual quantity remains resting.
14. As a FIX client submitting an Aggressing Limit Order, I want to receive price improvement when I cross at a better price than the Resting Order's price, so that I execute at the Resting Order's price rather than my own limit.
15. As a FIX client, I want Execution Reports to be routed back to the Session that submitted the Order, so that my system receives updates for its own orders without filtering traffic from other sessions.

### Market Data

16. As a FIX client, I want to request a one-time Snapshot of an Instrument's Order Book, so that I can see the current book state without committing to an ongoing Subscription.
17. As a FIX client, I want a Snapshot delivered as a single message containing all resting Orders, so that I receive a consistent view of the full book.
18. As a FIX client, I want to subscribe to Market Data for an Instrument, so that I receive a Snapshot followed by incremental updates whenever the Order Book changes.
19. As a FIX client, I want incremental Market Data updates delivered at the individual Order level (not aggregated by price level), so that I can observe queue position and priority — the information I need to test tools that reason about order flow.
20. As a FIX client, I want Trade publications in Market Data updates, so that I know what has been matched (Symbol, execution price, quantity).
21. As a FIX client, I want to hold Subscriptions to multiple Instruments simultaneously within one Session, so that I can monitor several markets at once.
22. As a FIX client, I want to unsubscribe from an Instrument's Market Data, so that I stop receiving updates when I no longer need them.
23. As a FIX client, I want to receive Market Data updates when resting Orders are cancelled due to a market close, so that my local Order Book reconstruction stays consistent with the Engine's state.

### Admin Portal — Instruments

24. As an Admin, I want to add a new Instrument Definition (Symbol, name, tick size, contract size, currency, expiry date), so that a new Instrument becomes available for trading.
25. As an Admin, I want to delist an Instrument, so that it is removed from the platform and no longer tradeable.
26. As an Admin, I want to view all Instruments and their current Market State, so that I can monitor the platform at a glance.

### Admin Portal — Market State

27. As an Admin, I want to open an Instrument's market manually, so that trading can begin immediately.
28. As an Admin, I want to close an Instrument's market manually, so that trading stops and all resting Orders are cancelled.
29. As an Admin, I want to halt an Instrument's market mid-session, so that I can test how connected clients react to a trading suspension while their resting Orders remain in the book.
30. As an Admin, I want to resume a halted Instrument, so that trading resumes and clients can observe the recovery.
31. As an Admin, I want to schedule an Instrument's daily open and close times, so that markets start and stop automatically without manual intervention during a test session.
32. As an Admin, I want expired Instruments to close automatically when their expiry date is reached, so that I can test client handling of instrument expiry without manual triggering.
33. As an Admin, I want all resting Orders on an Instrument to be cancelled when that market closes (manually, on schedule, or at expiry), so that there is no ambiguous residual state carried over.

### Admin Portal — FIX Connectivity

34. As an Admin, I want to add a FIX Session configuration (SenderCompID, TargetCompID, port), so that a new client system can connect to the Gateway.
35. As an Admin, I want to remove a FIX Session configuration, so that I can revoke connectivity for a client.
36. As an Admin, I want to view all configured FIX Sessions and their current connection status, so that I can monitor which clients are connected.

### Developer Workflow

37. As a trading tool developer, I want a stable, isolated matching environment I fully control, so that I can test my tool's order management, fill handling, and FIX session behaviour without interference from other market participants.
38. As a trading tool developer, I want to observe how my tool reacts to a market halt while it has resting Orders, so that I can verify my tool handles the suspension and subsequent rejection of new orders correctly.
39. As a trading tool developer, I want to observe how my tool handles instrument expiry, so that I can verify correct behaviour when a market closes and resting Orders are cancelled.
40. As a trading tool developer, I want to observe order-by-order Market Data to verify my tool's book reconstruction logic, so that I can confirm it correctly tracks queue position and priority.

## Implementation Decisions

### Monorepo structure

The MatchingEngine repository is a TypeScript monorepo with the following packages:

- `packages/shared-types` — domain types shared across packages (Order, Trade, InstrumentDefinition, MarketState, etc.). No dependencies on other internal packages.
- `packages/engine` — the Engine component. Depends only on `shared-types`. No I/O.
- `packages/gateway` — the Gateway component. Wraps the `fixserver` library. Depends on `shared-types` and `engine`.
- `packages/admin-api` — the Fastify HTTP API server. Depends on `shared-types` and `engine`.
- `packages/admin-ui` — the React + Vite frontend. Communicates with `admin-api` only.

### Engine: Order Book

One instance per Instrument, created and owned by the Instrument Registry. Encapsulates all matching logic: FIFO price/time priority, limit vs market order handling, price improvement for Aggressing Orders, partial fills. Purely functional — no I/O, no knowledge of Sessions.

Interface:
- `submit(order) → { trades: Trade[], updates: OrderStateUpdate[] }` — attempt to match the order; any unmatched remainder rests in the book (Limit) or is cancelled with reason (Market).
- `cancel(orderId) → OrderStateUpdate` — remove a resting Order.
- `snapshot() → Order[]` — return all resting Orders in price/time priority order.

### Engine: Instrument Registry

Manages all Instrument Definitions and their Market States. Enforces the state machine (`Closed → Open`, `Open → Closed`, `Open → Halted`, `Halted → Open`, `Halted → Closed`). On transition to `Closed`, cancels all resting Orders via the relevant Order Book and emits cancellation events for downstream routing. Creates one Order Book per Instrument on registration. Monitors expiry dates and triggers automatic close.

Interface:
- `add(def: InstrumentDefinition) → void`
- `delist(symbol: string) → void`
- `get(symbol: string) → Instrument | undefined`
- `list() → Instrument[]`
- `setMarketState(symbol: string, state: MarketState) → void`
- Emits: `marketStateChanged`, `ordersClosedOnMarketClose`

### Engine: Order Manager

Tracks all live Orders across all Instruments. Maintains a `sessionId → Set<orderId>` mapping so Execution Reports can be routed to the correct Session and so Cancellation Requests can be validated against the originating Session. Delegates Order Book mutation to the Instrument Registry.

Interface:
- `place(newOrder: NewOrder, sessionId: string) → OrderStateUpdate`
- `cancel(orderId: string, sessionId: string) → OrderStateUpdate` — returns a rejection update if the Session does not own the Order.
- `getSession(orderId: string) → string | undefined`
- `onSessionDisconnect(sessionId: string) → void` — cleans up session mapping without cancelling resting Orders (resting Orders survive a client disconnect).

### Engine: Market Data Publisher

Maintains the active Subscription registry (`sessionId → Set<symbol>`). Receives Order Book and Trade events from the Engine and fans them out to subscribed Sessions.

Interface:
- `subscribe(sessionId: string, symbol: string) → Snapshot` — registers the Subscription and returns the current Order Book Snapshot.
- `unsubscribe(sessionId: string, symbol: string) → void`
- `disconnect(sessionId: string) → void` — removes all Subscriptions for a disconnected Session.
- `publish(symbol: string, event: OrderBookEvent | TradeEvent) → void` — called after each Order Book mutation.

### Gateway

Wraps the `fixserver` library's Engine (which handles all FIX session-layer mechanics: logon, heartbeat, sequence numbers, reconnection). The Gateway consumes Application Messages from the fixserver async iterator and translates them into domain types. It translates domain events from the MatchingEngine Engine back into FIX Execution Reports and Market Data messages.

Validation performed at the Gateway before domain types are constructed:
- Required FIX fields are present (Symbol, Side, OrdType, Account tag 1, SenderSubID tag 50)
- Symbol exists in Reference Data
- For Limit orders: price is a whole number of ticks
- Instrument Market State is `Open` (else `Rejected`)

Session identity is the `SenderCompID` / `TargetCompID` pair, used as the `sessionId` throughout the Engine layer.

### Scheduler

The Scheduler manages timed Market State transitions. It reads schedule configuration (open time, close time) per Instrument from the Admin API and registers timers. It also monitors Instrument expiry dates. Both scheduled closes and expiry closes invoke `InstrumentRegistry.setMarketState(symbol, 'Closed')`.

### Market Data format

Market Data is delivered order-by-order (see `docs/adr/0001-order-by-order-market-data.md`). Each incremental update identifies a specific Order event: `OrderAdded`, `OrderCancelled`, `OrderFilled`, `OrderPartiallyFilled`. Clients reconstruct the full book from the opening Snapshot plus the stream of incremental events.

### Price improvement

When an Aggressing Limit Order crosses with a Resting Limit Order, the execution price is the Resting Order's price. The Aggressing Order's limit price is used only to determine whether a cross occurs, not to set the execution price. Market Orders always execute at the Resting Order's price; this is standard market order behaviour, not price improvement.

### Cancel on close

When an Instrument transitions to `Closed`, all resting Orders in its Order Book are cancelled. Each cancellation produces an `OrderStateUpdate` with state `Cancelled` and a `CancelReason` of `MarketClose`. The Order Manager routes an Execution Report to the originating Session for each cancelled Order.

### Resting Orders survive session disconnect

If a FIX Session disconnects, its resting Orders remain in the Order Book. Orders are only removed when explicitly cancelled via a Cancellation Request or when the market closes. This supports testing reconnect scenarios.

## Testing Decisions

### What makes a good test

Tests verify observable behaviour through the module's public interface — inputs in, outputs and emitted events out. Tests must not reach into internal data structures, assert on private fields, or mock collaborators that live inside the same module boundary. The goal is to be able to refactor internals freely without breaking tests.

### Modules under test

**Order Book:**
- Limit order rests when no matching counterparty exists
- Market order executes as a full immediate fill
- Market order partially fills and remainder is cancelled with reason
- Aggressing Limit Order receives price improvement (executes at Resting Order's price)
- FIFO priority: two resting orders at the same price, the earlier one fills first
- Partial fill leaves correct residual quantity resting in the book
- Cancel of a resting Order removes it and returns the state update
- Cancel of an unknown order ID returns an appropriate error

**Instrument Registry:**
- Instrument can be added and retrieved by Symbol
- Instrument can be delisted
- All valid Market State transitions succeed
- All invalid transitions are rejected
- Transition to `Closed` cancels all resting Orders and emits the correct events
- Automatic close fires when the expiry date is reached
- New Orders submitted to a `Closed` or `Halted` Instrument are rejected

**Order Manager:**
- `place` routes the order to the correct Order Book and returns the state update
- `cancel` succeeds when called from the originating Session
- `cancel` is rejected when called from a different Session
- `getSession` returns the correct session ID for a known order
- `onSessionDisconnect` cleans up session mapping without cancelling resting Orders

**Market Data Publisher:**
- `subscribe` returns a Snapshot and registers the Subscription
- Subsequent `publish` calls deliver events only to subscribed Sessions
- `unsubscribe` stops further delivery to that Session for that Symbol
- A Session subscribed to multiple Instruments receives events for each independently
- `disconnect` removes all Subscriptions for the disconnected Session

### Test tooling

Vitest — consistent with the `fixserver` library already in this workspace.

## Out of Scope

- **Cancel/replace** — explicitly deferred. Only New Order and Cancellation Request are supported in v1.
- **GTC / day order qualifiers** — all orders are session-scoped. No time-in-force handling beyond immediate execution (Market) and rest-until-cancelled-or-close (Limit).
- **Pre-Open market state** — the state machine starts at `Closed`. No pre-open auction or order accumulation phase.
- **Cross-Session cancellation** — a Cancellation Request must originate from the same Session that submitted the Order.
- **Internal client identifiers** — Session routing uses the FIX `SenderCompID` / `TargetCompID` pair directly. No admin-managed mapping layer.
- **Admin Portal authentication** — access control is delegated to the host network, consistent with the `fixserver` Admin Portal convention.
- **Aggregated Market Data** — all Market Data is order-by-order. See `docs/adr/0001-order-by-order-market-data.md`.
- **Performance optimisation** — message rates are expected to be low. No optimised data structures required in v1.
- **Additional order types** — only Market and Limit orders are supported in v1.

## Further Notes

- The Gateway is built on the `fixserver` library (`D:\NextCloud\src\fixserver`), which handles all FIX session-layer mechanics. The Gateway only needs to handle Application Messages (business-layer FIX messages).
- The `fixserver` library uses the same Fastify + React + Vite stack for its own Admin Portal. The MatchingEngine Admin Portal is a separate application.
- The `fixserver` `tsconfig.base.json` targets ES2022 with `NodeNext` module resolution — the MatchingEngine monorepo should adopt the same settings for consistency.
- Domain vocabulary is defined in `CONTEXT.md` at the repo root. All code, comments, issue titles, and test names should use terms from that glossary.
