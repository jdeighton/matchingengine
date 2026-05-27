# Worklog

A running log of implementation sessions. Read this first when resuming work.

---

## Session 1 — Issues #2–#9 (Engine core + FIX Gateway foundation)

### What was completed

Issues #2–#9 are **closed**. All 97 tests pass (`npx vitest run` from the repo root).

| Issue | What was built | Key files |
|-------|---------------|-----------|
| #2 | Monorepo scaffolding, shared types | `packages/shared-types/src/index.ts`, `tsconfig.base.json`, `package.json` workspaces |
| #3 | Order Book — matching logic | `packages/engine/src/order-book.ts` + `.test.ts` |
| #4 | Instrument Registry — Market State machine | `packages/engine/src/instrument-registry.ts` + `.test.ts` |
| #5 | Order Manager — session-scoped placement & cancellation | `packages/engine/src/order-manager.ts` + `.test.ts` |
| #6 | Market Data Publisher — subscription registry & fan-out | `packages/engine/src/market-data-publisher.ts` + `.test.ts` |
| #7 | FIX Gateway — session connectivity | `packages/gateway/src/fix-engine.ts`, `packages/gateway/src/gateway.ts` + `.test.ts` (first 6 tests) |
| #8 | FIX Gateway — New Order round-trip | `packages/gateway/src/gateway.ts` + `.test.ts` (tests 7–20) |
| #9 | FIX Gateway — Order matching & fill Execution Reports | `packages/gateway/src/gateway.ts` + `.test.ts` (tests 21–28) |

For domain vocabulary see `CONTEXT.md`. For the PRD see `docs/prd/0001-initial-prd.md`. For the order-by-order Market Data decision see `docs/adr/0001-order-by-order-market-data.md`.

---

### Non-obvious implementation details

These won't appear in any other document but matter for future work.

#### Gateway test architecture

The Gateway's async FIX message loop (`for await ... of engine.messages()`) is not exercised in tests. Instead, `gateway.handleMessage(msg: IMessage)` is public and tests call it directly. The `IFixEngine` and `IMessage` interfaces in `packages/gateway/src/fix-engine.ts` are thin testability wrappers over the real `fixserver` types.

`makeNewOrderMsg` in `gateway.test.ts` accepts a second `sessionId` argument (defaults to `'GW-CLI-FIX.4.4'`). The matching tests use two constants:

```
SESSION_A = 'SESSION-A'   // resting order owner
SESSION_B = 'SESSION-B'   // aggressor
```

#### Three bugs found and fixed during Issue #9

**1 — OrderBook: no PartiallyFilled update for resting orders**

`OrderBook.submit()` originally did not push an `OrderStateUpdate` when a Resting Order was partially matched (aggressor smaller than resting). It only emitted a `Filled` update when the resting order was exhausted. Fixed by adding an `else` branch in the match loop (`packages/engine/src/order-book.ts` lines 46–50).

**2 — OrderManager: aggressor placement overwrote resting order's session**

After the engine returned the match result, `OrderManager.place()` iterated `result.updates` and re-mapped every `PartiallyFilled` order to the *aggressor's* session — overwriting the correct session for the Resting Order. Fixed by removing that loop entirely. Only the unconditional `sessionByOrder.set(order.id, sessionId)` at the end of `place()` is needed.

**3 — makeNewOrderMsg silently dropped the sessionId argument**

The helper only accepted `overrides`, so `makeNewOrderMsg({...}, SESSION_B)` silently ignored `SESSION_B`. Fixed by adding `sessionId` as a second parameter with a default.

#### LeavesQty computation in the Gateway

After calling `orderManager.place()`, the Gateway takes a post-trade snapshot and builds `orderInBook = Map<orderId, Order>` from it. For each `OrderStateUpdate`:

- If the order is **still in the book** (found in snapshot): `originalQty = inBook.quantity`, `leavesQty = originalQty - filledQty`
- If the order is **Filled** (not in snapshot, not Cancelled): `originalQty = filledQty` (fully filled → original = filled)
- If the order is **Cancelled** (Market order, not in snapshot): `originalQty = qty` (the submitted quantity)
- Terminal states (`Filled`, `Cancelled`, `Rejected`) always produce `leavesQty = 0`

---

### Infrastructure decisions made this session

#### vitest workspace config

Running `npx vitest run` from the monorepo root previously ignored per-package `vitest.config.ts` files. Fixed by adding `vitest.workspace.ts` at the repo root:

```typescript
// vitest.workspace.ts
import { defineWorkspace } from 'vitest/config';
export default defineWorkspace(['packages/engine', 'packages/gateway']);
```

Each new package with tests should be added here.

#### Gateway vitest alias (packages/gateway/vitest.config.ts)

The gateway tests import `@matchingengine/engine` which the `package.json` exports field resolves to `dist/`. The vitest config overrides this with a source alias so tests always run against TypeScript source:

```typescript
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(__dirname, '../..');   // packages/gateway → packages → repo root
alias: {
  '@matchingengine/engine': resolve(root, 'packages/engine/src/index.ts'),
  '@matchingengine/shared-types': resolve(root, 'packages/shared-types/src/index.ts'),
}
```

**Important**: the dist still matters. When the root vitest workspace runs and the alias is active, tests use source. But if you run the engine's `tsc --build` and the dist becomes stale, any test path that bypasses the alias will silently pick up the old compiled output. Keep the dist in sync after source changes: `npx tsc --build packages/engine/tsconfig.json`.

#### tsconfig excludes

`packages/engine/tsconfig.json` and `packages/shared-types/tsconfig.json` both have `"exclude": ["src/**/*.test.ts"]` so test files do not block the `tsc --build` output.

---

### Running tests

```bash
# All packages from repo root (recommended)
npx vitest run

# Single package
npx vitest run packages/engine
npx vitest run packages/gateway

# Watch mode
npx vitest
```

---

## Session 2 — Issue #10 (FIX Gateway — Cancellation Request flow)

### What was completed

Issue #10 is **closed**. All 104 tests pass (`npx vitest run` from the repo root).

| Behavior | Test |
|----------|------|
| Client cancels own resting Order | → `Cancelled` ER routed to that session |
| Cancelled ER carries correct fields | OrderID, ClOrdID, Symbol, Side, OrderQty (from pre-cancel snapshot), CumQty, LeavesQty=0 |
| Partially-filled Order cancelled | → `Cancelled` ER with `CumQty` = fills so far |
| Cancel from a different Session | → `Rejected` ER to the requesting session |
| Unknown Order ID | → `Rejected` ER |
| Already-Filled Order cancel | → `Rejected` ER with `cancelReason = CannotCancelFilledOrder` |
| Engine-initiated cancel (market close) | → `Cancelled` ER for each resting Order, routed to its originating Session |

### Files changed

| File | Change |
|------|--------|
| `packages/shared-types/src/index.ts` | Added `'CannotCancelFilledOrder'` to `CancelReason` |
| `packages/engine/src/order-manager.ts` | New `ClosedOrderInfo` type; added `quantityByOrder`, `sideByOrder` tracking; `cancel()` try/catch for already-terminal orders; `onOrdersCancelledOnClose()` method that fires Gateway subscribers BEFORE cleanup |
| `packages/engine/src/index.ts` | Exports `ClosedOrderInfo` |
| `packages/gateway/src/gateway.ts` | Added `TAG.ORIG_CL_ORD_ID`; constructor wires `orderManager.onOrdersCancelledOnClose`; `handleMessage` routes `35=F`; new `handleCancelRequest`, `sendEngineInitiatedCancelER`, `buildCancelER` methods |
| `packages/gateway/src/gateway.test.ts` | 7 new tests in `describe('OrderCancelRequest')` |

---

### Non-obvious implementation details

#### OrderManager: event ordering for market-close cancellations

When the market closes, `InstrumentRegistry.cancelAllResting` fires `onOrdersCancelledOnClose` handlers in registration order. `OrderManager` registers its cleanup handler first (in its constructor). The Gateway's `onOrdersCancelledOnClose` handler therefore runs SECOND — after the `sessionByOrder` map has been cleared.

**Fix**: The `OrderManager` now fires its own `closedOrdersHandlers` subscribers BEFORE cleaning up its internal maps. The Gateway subscribes to `orderManager.onOrdersCancelledOnClose` (not the registry's event directly), so it always receives session data intact.

The enriched `ClosedOrderInfo` carries `{ orderId, sessionId, update, originalQty, side }` — all the data the Gateway needs to build the Execution Report without any further lookups.

#### OrderQty in cancel ERs: pre-cancel snapshot lookup

For client-initiated cancel ERs, the Gateway takes a snapshot via `registry.getSnapshot(symbol)` BEFORE calling `orderManager.cancel()`. This gives the order's original `quantity` for `OrderQty (38)`. If the order is not found in the snapshot (e.g. Symbol missing or order no longer resting), `OrderQty` falls back to 0.

For engine-initiated cancel ERs, `OrderQty` comes directly from `ClosedOrderInfo.originalQty`, which the `OrderManager` stores in `quantityByOrder` at placement time.

#### Already-terminal orders: `cancel()` try/catch

When a Filled order's `orderId` is passed to `orderManager.cancel()`, the session mapping is still present (it's only deleted on explicit cancel or close). The call reaches `registry.cancel()` → `OrderBook.cancel()`, which throws "Order not found" because the order has been removed from the book. The `OrderManager.cancel()` method now wraps this in try/catch, returning `Rejected` with `cancelReason: 'CannotCancelFilledOrder'`.

---

## Session 3 — Issue #11 (FIX Gateway — Reference Data)

### What was completed

Issue #11 is **closed**. All 110 tests pass.

| Behavior | Test |
|----------|------|
| SecurityListRequest → SecurityList (MsgType=y) | Tracer bullet |
| Response routed to requesting Session | ✓ |
| SecurityReqID (320) echoed in response | ✓ |
| One group per registered Instrument; NoRelatedSym (146) matches count | ✓ |
| Each group carries all 6 fields (Symbol, name, tickSize, contractSize, currency, expiryDate) | ✓ |
| Empty registry → 0 groups, SecurityRequestResult=0, no error | ✓ |

### Files changed

| File | Change |
|------|--------|
| `packages/gateway/src/fix-engine.ts` | Added `sendGroupMessage(sessionId, header, groups)` to `IFixEngine` |
| `packages/gateway/src/gateway.ts` | New TAG constants (320, 322, 560, 146, 107, 15, 231, 541, 969); `handleMessage` routes `35=x`; new `handleSecurityListRequest` method; `toFIXDate` helper |
| `packages/gateway/src/gateway.test.ts` | `MockFixEngine` implements `sendGroupMessage` + `sentGroups` array; 6 new tests in `describe('SecurityListRequest')` |

### FIX tag mapping for SecurityList

**Request (35=x):**
- `SecurityReqID (320)` — client's request ID

**Response (35=y) — header:**
- `SecurityResponseID (322)` — sequential response ID
- `SecurityReqID (320)` — echoed
- `SecurityRequestResult (560) = '0'` — valid request
- `NoRelatedSym (146)` — instrument count

**Response — per-instrument group:**
- `Symbol (55)` — ticker
- `SecurityDesc (107)` — name
- `Currency (15)` — currency
- `ContractMultiplier (231)` — contract size
- `MaturityDate (541)` — expiry date (YYYYMMDD)
- `MinPriceIncrement (969)` — tick size (technically FIX 5.0 tag, but standard in practice for FIX 4.4 implementations)

### Non-obvious implementation detail: `sendGroupMessage`

The existing `sendMessage(sessionId, Map<number,string>)` interface is flat and cannot represent FIX repeating groups. A new `sendGroupMessage(sessionId, header, groups)` method was added to `IFixEngine` to handle messages with repeating groups. The `header` Map carries non-repeating fields; `groups` is an array of Maps, one per repeating entry.

Existing callers of `sendMessage` are unaffected. The mock adds a `sentGroups` array that tests assert against.

---

## Session 4 — Issue #12 (FIX Gateway — Market Data Snapshots & Subscriptions)

### What was completed

Issue #12 is **closed**. All 124 tests pass.

| Behavior | Test |
|----------|------|
| Snapshot (type=0) → `35=W` with current book state | ✓ |
| Snapshot W carries correct fields per resting order | ✓ |
| Snapshot W echoes MDReqID | ✓ |
| Snapshot-only: no X after events arrive | ✓ |
| Subscription (type=1) → W snapshot sent first | ✓ |
| Subscription: `OrderAdded` → X with New action, correct price/size | ✓ |
| Subscription: `TradeEvent` → X with MDEntryType=2 (Trade) | ✓ |
| Subscription: `OrderFilled` → X with Delete action, size=0 | ✓ |
| Subscription: `OrderPartiallyFilled` → X with Change action, remaining size | ✓ |
| Subscription: `OrderCancelled` → X with Delete action | ✓ |
| Unsubscribe (type=2) → no further X | ✓ |
| Multiple instruments: independent update streams per symbol | ✓ |
| No X after session disconnect | ✓ |
| End-to-end: subscribe + place resting Limit Order → OrderAdded X delivered | ✓ |

### Files changed

| File | Change |
|------|--------|
| `packages/gateway/src/gateway.ts` | New TAG constants (262, 263, 268, 269, 270, 271, 278, 279); `handleMessage` routes `35=V`; `handleNewOrder` now takes pre-placement snapshot and calls `publishOrderBookEvents`; `handleCancelRequest` publishes `OrderCancelled` event; new methods: `handleMarketDataRequest`, `publishOrderBookEvents`, `sendSnapshotFullRefresh`, `sendIncrementalRefresh` |
| `packages/gateway/src/gateway.test.ts` | 14 new tests in `describe('MarketDataRequest')` |

### FIX tag mapping for Market Data

**MarketDataRequest (35=V):**
- `MDReqID (262)` — echoed in all responses
- `SubscriptionRequestType (263)` — `'0'`=Snapshot, `'1'`=Subscribe, `'2'`=Unsubscribe
- `Symbol (55)` — instrument

**MarketDataSnapshotFullRefresh (35=W) — header:**
- `MDReqID (262)`, `Symbol (55)`, `NoMDEntries (268)`
- Per order group: `MDEntryType (269)` 0=Bid/1=Offer, `MDEntryID (278)`, `MDEntryPx (270)`, `MDEntrySize (271)` (remaining qty)

**MarketDataIncrementalRefresh (35=X) — header:**
- `MDReqID (262)`, `NoMDEntries (268) = '1'`
- Per entry: `MDUpdateAction (279)` 0=New/1=Change/2=Delete, `MDEntryType (269)`, `Symbol (55)`, `MDEntryID (278)`, `MDEntryPx (270)`, `MDEntrySize (271)`

**MDUpdateAction mapping:**
- `OrderAdded` → 0 (New)
- `OrderPartiallyFilled` (resting side) → 1 (Change); (new partially-filled aggressor enters book) → 0 (New)
- `OrderFilled` / `OrderCancelled` → 2 (Delete)
- `TradeEvent` → 0 (New), `MDEntryType=2` (Trade)

### Non-obvious implementation details

#### Market data publishing in `handleNewOrder`

`handleNewOrder` now takes a **pre-placement snapshot** (before calling `orderManager.place()`) to capture resting orders that may be consumed by the trade. After placing:
- Orders in the post-snapshot → `New`/`PartiallyFilled` resting (used as-is)
- Orders in pre-snapshot only → `Filled` resting (reconstruct from pre-snapshot + update)
- Neither → the aggressor's own new order (reconstruct from request params + `result.updates.at(-1)`)

The aggressor's update is always the **last** entry in `result.updates` (OrderBook invariant).

#### PartiallyFilled event disambiguation

A `PartiallyFilled` update can mean:
- A **resting** order partially hit → `OrderPartiallyFilled` (1=Change): the order existed before (in `preBook`)
- An **aggressor** that partially crossed and now rests → `OrderAdded` (0=New): not in `preBook`

Distinction: `preBook.has(update.orderId)` → resting; otherwise → aggressor.

---

## Session 5 — Issue #13 (Admin API — Instrument CRUD & Market State transitions)

### What was completed

Issue #13 is **closed**. All 141 tests pass.

| Behavior | Test |
|----------|------|
| `POST /instruments` with valid body → 201, returns instrument with `marketState: Closed` | ✓ |
| `POST /instruments` with duplicate Symbol → 409 | ✓ |
| `POST /instruments` with missing/invalid fields → 422 with details array | ✓ |
| `POST /instruments` with `tickSize: 0` → 422 | ✓ |
| `DELETE /instruments/:symbol` → 204 | ✓ |
| `DELETE /instruments/:symbol` for unknown symbol → 404 | ✓ |
| `GET /instruments` returns all instruments with symbol and marketState | ✓ |
| `GET /instruments` returns empty array when registry is empty | ✓ |
| `POST /instruments/:symbol/open` Closed → Open → 200 | ✓ |
| `POST /instruments/:symbol/halt` Open → Halted → 200 | ✓ |
| `POST /instruments/:symbol/resume` Halted → Open → 200 | ✓ |
| `POST /instruments/:symbol/close` Open → Closed → 200 | ✓ |
| Invalid state transition → 409 with `currentState` and `requestedState` | ✓ |
| Unknown symbol on state transition → 404 | ✓ |
| `POST /instruments/:symbol/schedule` stores schedule → 200 with schedule echoed | ✓ |
| `POST /instruments/:symbol/schedule` with malformed times → 422 | ✓ |
| `POST /instruments/:symbol/schedule` unknown symbol → 404 | ✓ |

### Files changed

| File | Change |
|------|--------|
| `packages/admin-api/package.json` | Added `fastify` dependency, `vitest` devDependency |
| `packages/admin-api/vitest.config.ts` | Created — source aliases for engine + shared-types |
| `packages/admin-api/src/server.ts` | New — `buildServer(registry)` Fastify factory |
| `packages/admin-api/src/server.test.ts` | New — 17 tests via `app.inject()` |
| `vitest.workspace.ts` | Added `'packages/admin-api'` |

### Architecture

`buildServer(registry: InstrumentRegistry): FastifyInstance` — the server is a pure factory that takes the registry as a parameter. Tests instantiate a real `InstrumentRegistry` and a real Fastify app, using Fastify's built-in `app.inject()` for HTTP testing — no mocking needed.

Schedule storage is an in-process `Map<string, {openTime, closeTime}>` inside the server closure, consumed by the Scheduler in Issue #15.

### Non-obvious implementation details

#### Market State route loop

The four transition actions (`open`, `close`, `halt`, `resume`) are registered via a single `for … of Object.entries(TRANSITION_STATES)` loop. This avoids duplicating the 404/409 error handling. `resume` and `open` both target `'Open'` — the distinction is only in the URL path.

#### Validation approach

Body validation is hand-rolled (no schema library). Required string fields must be non-empty; required number fields must be positive. `expiryDate` is validated by constructing a `Date` and checking `isNaN`. The `422` response always carries a `details` array listing every violation.

---

## Session 6 — Issue #14 (Admin API — FIX Session management)

### What was completed

Issue #14 is **closed**. All 155 tests pass.

| Behavior | Test |
|----------|------|
| `POST /sessions` with valid body → 201 with `sessionId` and `status: inactive` | ✓ |
| `POST /sessions` with duplicate senderCompId/targetCompId/beginString → 409 | ✓ |
| `POST /sessions` with missing required fields → 422 with details array | ✓ |
| `DELETE /sessions/:sessionId` → 204, session removed from Gateway | ✓ |
| `DELETE /sessions/:sessionId` unknown ID → 404 | ✓ |
| `GET /sessions` returns all sessions with `status: active \| inactive` | ✓ |
| `GET /sessions` returns empty array when no sessions configured | ✓ |
| Gateway: `addSession()` returns the session ID | ✓ |
| Gateway: `getSessions()` returns sessions with `inactive` status initially | ✓ |
| Gateway: status reflects `active` after `'active'` event fires | ✓ |
| Gateway: status reflects `inactive` after `'disconnected'` event fires | ✓ |
| Gateway: `hasSession()` returns true/false correctly | ✓ |
| Gateway: `hasSession()` returns false after `removeSession()` | ✓ |

### Files changed

| File | Change |
|------|--------|
| `packages/gateway/src/gateway.ts` | Added `sessionStatuses` map; `addSession()` now returns `string`; `watchSession()` tracks `'active'`; new `getSessions()`, `hasSession()` methods |
| `packages/gateway/src/gateway.test.ts` | 7 new tests in `describe('session management')` |
| `packages/admin-api/src/gateway-admin.ts` | New — `IGatewayAdmin`, `SessionRequest`, `SessionInfo` interfaces |
| `packages/admin-api/src/server.ts` | `buildServer()` accepts optional `gateway: IGatewayAdmin`; session routes registered when `gateway` is provided |
| `packages/admin-api/src/server.test.ts` | `MockGateway` class; 7 new session endpoint tests |

### Non-obvious implementation details

#### Session ID format

The real FIX engine (`Session` class) computes `id = senderCompId-targetCompId-beginString`. The Admin API derives the candidate ID from the request body (using `'FIX.4.4'` as the default `beginString`) for duplicate detection before calling `gateway.addSession()`. This avoids a round-trip that would require adding the session and then checking if it was a duplicate.

#### `gateway` parameter is optional

`buildServer(registry, gateway?)` — the session routes are only registered when `gateway` is provided. Existing Admin API tests for instrument management pass `undefined` (or nothing) and are unaffected.

#### `SessionStatus` → `'active' | 'inactive'`

`SessionStatus = 'disconnected' | 'connecting' | 'logon_sent' | 'active' | 'logout_sent'`. Only `'active'` is considered "active" in the Admin API response. All other status values map to `'inactive'`.

---

## Session 7 — Issue #15 (Scheduler — timed opens/closes & expiry monitoring)

### What was completed

Issue #15 is **closed**. All 163 tests pass.

| Behavior | Test |
|----------|------|
| `setSchedule(symbol, openTime, closeTime)` → market opens at UTC openTime | ✓ |
| `setSchedule` → market closes at UTC closeTime | ✓ |
| `cancelSchedule` → no transitions fire after cancel | ✓ |
| Daily re-registration: open fires again the next day | ✓ |
| Delisted instrument (no cancel call) → no infinite timer loop, no throw | ✓ |
| `setSchedule` replaces a previous schedule (old timer cleared) | ✓ |
| `POST /instruments/:symbol/schedule` → `scheduler.setSchedule()` called | ✓ |
| `DELETE /instruments/:symbol` → `scheduler.cancelSchedule()` called | ✓ |

### Files changed

| File | Change |
|------|--------|
| `packages/admin-api/src/scheduler.ts` | New — `Scheduler` class with `setSchedule` / `cancelSchedule` |
| `packages/admin-api/src/scheduler.test.ts` | New — 6 tests via `vi.useFakeTimers()` |
| `packages/admin-api/src/server.ts` | `buildServer()` accepts optional `scheduler: Scheduler`; `DELETE /instruments` calls `scheduler?.cancelSchedule()`; `POST /schedule` calls `scheduler?.setSchedule()` |
| `packages/admin-api/src/server.test.ts` | 2 wiring tests via `vi.spyOn` |

### Architecture

`Scheduler` is a standalone class with no external dependencies beyond `InstrumentRegistry`. It owns a `Map<string, { open?: Timer; close?: Timer }>` and uses `setTimeout` / `clearTimeout` directly. All times are UTC. After each timer fires it re-registers for the next 24 h occurrence.

`buildServer` accepts `scheduler` as a third optional parameter. The wiring is minimal: two opt-chained calls (`scheduler?.setSchedule(...)` and `scheduler?.cancelSchedule(...)`). Scheduler timing behaviour is tested in isolation via `vi.useFakeTimers()`.

### Non-obvious implementation details

#### Why fake timers are not used in the server wiring tests

`vi.useFakeTimers()` in `beforeEach` causes `await app.inject(...)` to hang — Fastify's internal async bootstrapping uses timers that the fake clock freezes. The solution: wiring tests use `vi.spyOn` to verify `setSchedule`/`cancelSchedule` are called; actual timing behaviour is proven separately in `scheduler.test.ts` where there is no Fastify HTTP overhead.

#### Daily re-registration guard

After each timer fires, `scheduleNext` only re-registers if `this.timers.has(symbol)` AND `this.registry.get(symbol) !== undefined`. The first condition handles explicit `cancelSchedule` calls; the second handles instruments that were delisted without calling `cancelSchedule` (defensive — prevents an infinite loop of failing transitions).

#### Expiry is handled by `InstrumentRegistry.scheduleExpiry`

The InstrumentRegistry already schedules expiry timers when `add()` is called. When expiry fires, it calls `setMarketState(symbol, 'Closed')`, which cancels resting orders. The Gateway's `onOrdersCancelledOnClose` handler then sends Execution Reports. Acceptance criteria 4 and 5 (expiry ERs) are therefore already met by prior issues; the Scheduler only adds the daily open/close scheduling.

---

## Session 8 — Issue #16 (Admin UI — Instrument & Market State management)

### What was completed

Issue #16 is **closed**. All 171 tests pass.

| Behavior | Test |
|----------|------|
| Instruments page lists all instruments with current Market State badge | ✓ |
| "Add Instrument" form validates required fields client-side before submitting | ✓ |
| Successfully added instrument appears in the table without a full page reload | ✓ |
| Delist requires a confirmation step; no API call until confirmed | ✓ |
| Open/Close/Halt/Resume buttons shown only for valid transitions | ✓ |
| Triggering a state transition updates the badge in the table | ✓ |
| "Set Schedule" saves open/close times via `POST /instruments/:symbol/schedule` | ✓ |
| API errors are surfaced as readable messages in the table row | ✓ |

### Files changed

| File | Change |
|------|--------|
| `packages/admin-ui/package.json` | Added react, react-dom; devDeps: vite, @vitejs/plugin-react, vitest, jsdom, @testing-library/* |
| `packages/admin-ui/vite.config.ts` | Vite config with React plugin; proxy `/instruments` and `/sessions` → `localhost:3001` |
| `packages/admin-ui/vitest.config.ts` | jsdom environment, globals:true, setupFiles |
| `packages/admin-ui/src/test-setup.ts` | Imports `@testing-library/jest-dom` |
| `packages/admin-ui/src/api.ts` | API client + `Instrument` type + `VALID_ACTIONS` table |
| `packages/admin-ui/src/InstrumentsPage.tsx` | Main page component |
| `packages/admin-ui/src/InstrumentsPage.test.tsx` | 8 tests via RTL + mocked `api` module |
| `packages/admin-ui/index.html` | Vite entry HTML |
| `packages/admin-ui/src/main.tsx` | React entry point |
| `vitest.workspace.ts` | Added `'packages/admin-ui'` |

### Architecture

**`api.ts`** — thin `fetch` wrapper exposing `getInstruments`, `addInstrument`, `delistInstrument`, `setMarketState`, `setSchedule`. Also exports `VALID_ACTIONS: Record<MarketState, StateAction[]>` used by both the component and the tests.

**`InstrumentsPage.tsx`** — single-component page. Per-row UI state (`confirmDelist`, `showSchedule`, `actionError`) is kept in a `rowStates: Record<string, RowState>` map alongside the instruments array. The table polls via `setInterval(refresh, 5000)`. State transitions update the badge optimistically via `setInstruments` without waiting for a re-fetch.

**Testing approach** — `vi.mock('./api.js', ...)` mocks the API module; RTL's `userEvent` drives all interactions. Globals (`globals: true`) needed because `@testing-library/jest-dom` calls `expect.extend` at import time.

### Non-obvious implementation detail

The `/confirm/i` regex in the delist test matched both the `<span>Confirm delist ESZ4?</span>` and the `<button>Confirm</button>`. Fixed by asserting `getByText(/confirm delist/i)` for the message and `getByRole('button', { name: /^confirm$/i })` for the button.

---

## Session 9 — Issue #17 (Admin UI — FIX Session connectivity)

### What was completed

Issue #17 is **closed**. All 178 tests pass.

| Behavior | Test |
|----------|------|
| Sessions page lists all sessions with `Active` / `Inactive` status badge | ✓ |
| "Add Session" form validates SenderCompID, TargetCompID, port client-side | ✓ |
| Successfully added session appears in the table with all columns | ✓ |
| Remove requires a confirmation step before calling the API | ✓ |
| Removed session disappears from the table | ✓ |
| `Active` badge shown when status is `'active'` | ✓ |
| API errors surfaced as readable messages in the row | ✓ |

### Files changed

| File | Change |
|------|--------|
| `packages/admin-ui/src/api.ts` | Added `SessionInfo`, `SessionDisplay`, `AddSessionRequest` types; `getSessions`, `addSession`, `removeSession` API methods |
| `packages/admin-ui/src/SessionsPage.tsx` | New — sessions page component |
| `packages/admin-ui/src/SessionsPage.test.tsx` | New — 7 tests via RTL |

### Non-obvious implementation detail: `useRef` for session metadata

Session metadata (senderCompId, targetCompId, port) is tracked client-side because `GET /sessions` only returns `{ sessionId, status }`. Storing this in `useState` caused a bug: `setSessionMeta(delete)` after remove triggered `refresh` to be recreated (it depended on `sessionMeta` via `useCallback`), which re-ran `useEffect → refresh()`, which re-fetched from the mock and restored the removed session.

Fix: store metadata in `useRef` instead of `useState`. `refresh`'s `useCallback` deps are empty (`[]`); it reads `sessionMetaRef.current` at call time. This breaks the dep chain and removes the spurious re-fetch.

---

## Next up

See the GitHub issue tracker: https://github.com/jdeighton/matchingengine/issues

---

## Previously completed — Issues #2–#9 (Engine core + FIX Gateway foundation)
