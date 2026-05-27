# Matching Engine

An internal electronic trading platform for testing trading tools. Provides order matching, market data, and FIX 4.4 connectivity. Controllability and observability are primary goals; performance is not.

## Components

**MatchingEngine**: The overall system — encompasses all three components below.

**Engine**: The matching core. Owns Order Books, executes matching, manages Market State transitions (including automatic close on expiry), and publishes Market Data. Has no knowledge of FIX.

**Gateway**: The FIX 4.4 boundary. Validates inbound FIX messages (including tick-size and field checks), translates to/from internal representations, manages Sessions, and routes Execution Reports back to the originating Session.

**Admin Portal**: The web UI (Fastify + React + Vite) for managing Instrument Definitions, triggering Market State transitions, and configuring Gateway connectivity points.

## Language

**Instrument**:
The tradeable entity — has a tick size, a market state, and its own order book.
_Avoid_: Product, contract, security

**Symbol**:
The short string identifier for an Instrument used in messages (e.g. `CLM26`).
_Avoid_: Ticker, instrument code

**Account**:
The clearing or margin account an order is booked against. Carried on every order (FIX tag 1). Required.
_Avoid_: Client, firm

**Trader**:
The individual or desk placing the order within an Account. Carried on every order (FIX tag 50). Required.
_Avoid_: User, operator

**Session**:
A FIX connection between a client and the Gateway, identified by its `SenderCompID` / `TargetCompID` pair. Execution reports are routed back on the Session whose comp ID pair matches the one that submitted the order.
_Avoid_: Connection, channel, client

**Order**:
The working entity tracked by the Engine from submission through to a terminal state. Carries a required Account and Trader. Has one of five states: `New`, `PartiallyFilled`, `Filled`, `Cancelled`, `Rejected`.
_Avoid_: Request, instruction

**Market State**:
The lifecycle state of an Instrument. Governs whether the Engine will accept new Orders and perform matching.
- `Closed` — no Orders accepted, no matching. Resting Orders are cancelled when transitioning into this state.
- `Open` — Orders accepted, matching active.
- `Halted` — mid-session suspension triggered by the admin portal. New Orders are rejected (same as `Closed`); resting Orders remain in the Order Book. Resuming returns to `Open`.

Valid transitions: `Closed → Open`, `Open → Closed`, `Open → Halted`, `Halted → Open`, `Halted → Closed`. The Engine automatically transitions an Instrument to `Closed` when its expiry date is reached, cancelling all resting Orders.
_Avoid_: Status, trading status, session state

**Aggressing Order**:
The incoming Order that triggers a match by crossing the spread. For limit-vs-limit matches, the Aggressing Order receives any price improvement (it executes at the Resting Order's price, not its own limit price).
_Avoid_: Aggressor, taker, initiator

**Resting Order**:
An Order already in the Order Book waiting to be matched. Sets the execution price in all matches (FIFO: first order at a price level gets matched first).
_Avoid_: Passive order, maker, standing order

**Order Book**:
The ordered collection of resting Orders for a single Instrument, organised by price and time priority (FIFO). One Order Book exists per Instrument.
_Avoid_: Book, depth, ladder

**Market Data**:
Real-time information published by the Engine about an Instrument's Order Book and completed Trades. Delivered order-by-order (individual Order entries, not aggregated price levels), giving subscribers full visibility into queue position and priority.
_Avoid_: Feed, price feed, depth feed

**Instrument Definition**:
The static data record describing a single Instrument. Contains: Symbol, human-readable name, tick size (minimum valid price increment), contract size, currency, and expiry date. Created and managed via the admin portal. An order with a price that is not a whole number of ticks is rejected by the Gateway.
_Avoid_: Product definition, contract spec, security master

**Reference Data**:
The full catalogue of Instrument Definitions available to clients on request. A client downloads Reference Data to discover what Instruments exist and their properties before trading.
_Avoid_: Instrument catalogue, product list, security list

**Snapshot**:
A one-time, full delivery of the current Order Book for a single Instrument. Stateless — the Engine sends it and tracks nothing further. The entire book is delivered as a single message.
_Avoid_: Download, dump, refresh

**Subscription**:
A persistent registration by a Session to receive incremental Order Book and Trade updates for a specific Instrument. Begins with a full Snapshot, then streams updates until the Session unsubscribes or disconnects. A Session may hold Subscriptions to multiple Instruments simultaneously. The Engine tracks active Subscriptions per Session.
_Avoid_: Stream, feed, listener

**Trade**:
The record of a completed match between two Orders. Carries Symbol, price, and quantity. Published as part of Market Data so subscribers know what has been matched.
_Avoid_: Fill, execution, match (as a noun)

**New Order**:
A client's instruction to create an Order. Carries Symbol, side (buy/sell), order type (Market or Limit), quantity, price (Limit orders only), Account, and Trader.
_Avoid_: Order request, order submission, new order single

**Cancellation Request**:
A client's instruction to cancel a specific resting Order. Only accepted if the Order is in `New` or `PartiallyFilled` state. Must originate from the same Session that submitted the Order — cross-Session cancellation is not permitted.
_Avoid_: Cancel order, cancel request, order cancel

**Execution Report**:
The single outbound message type the Gateway sends to a Session to communicate all Order state changes: New Order acknowledgement, fill notifications, cancellation confirmations, and rejections. Engine-initiated state changes (e.g. market order remainder cancellation, expiry-triggered close) are relayed to the originating Session as Execution Reports. A separate rejection message type is not used — the Order State within the Execution Report carries the full semantics.
_Avoid_: Ack, fill message, rejection message, cancel confirm

## Example dialogue

> **Dev:** A client connected, subscribed to CLM26, then sent a New Order with a limit price of 100.10. Nothing happened.
>
> **Domain expert:** What's the tick size on that Instrument?
>
> **Dev:** 0.25.
>
> **Domain expert:** Then 100.10 isn't a valid price — it's not a whole number of ticks. The Gateway should have rejected that Order immediately and sent back an Execution Report with state `Rejected`. The Engine never saw it.
>
> **Dev:** Got it. Separately — the client sent a Cancellation Request for an Order from a different Session. Should that go through?
>
> **Domain expert:** No. Cancellation Requests must come from the originating Session. The Gateway should reject it.
>
> **Dev:** What happens to the client's Subscription when the Instrument expires?
>
> **Domain expert:** The Engine closes the Instrument automatically, cancelling all Resting Orders. Each originating Session gets an Execution Report. Subscriptions receive a final Market Data update reflecting the cancellations, then the Instrument is Closed — no further updates.

---

**Order State**:
One of five values describing where an Order is in its lifecycle.
- `New` — accepted by the Engine, resting in the book or pending match.
- `PartiallyFilled` — one or more fills have occurred; residual quantity remains.
- `Filled` — fully matched; terminal.
- `Cancelled` — terminated by the Engine (market order remainder, insufficient liquidity) or by a client cancellation request. The reason is carried in a CancelReason field on the execution report, not encoded in the state.
- `Rejected` — refused by the Gateway before reaching the Engine due to a validation failure (unknown Symbol, missing required field, malformed message). The Engine never sees a Rejected order.
_Avoid_: Status, order status
