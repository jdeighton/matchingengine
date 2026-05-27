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

## Next up — Issue #10: FIX Gateway — Cancellation Request flow

See: https://github.com/jdeighton/matchingengine/issues/10

**Summary of what to build:**

Handle `OrderCancelRequest (35=F)` in the Gateway. Parse the FIX message, call `orderManager.cancel(request, sessionId)`, and send back an Execution Report. The Order Manager already enforces cross-session protection and returns a `Rejected` update for unknown or cross-session cancels; the Gateway just needs to translate and route.

Acceptance criteria from the issue:
- Client can cancel its own resting Order → `Cancelled` ER
- Partially filled Order can be cancelled → `Cancelled` ER
- Cancel from a different Session → `Rejected` ER
- Unknown Order ID → `Rejected` ER
- Already-terminal Order → `Rejected` ER
- Engine-initiated cancellations (market close, expiry) → `Cancelled` ER routed to the originating Session

**FIX fields for `OrderCancelRequest (35=F)`:**

The cancel request carries `ClOrdID (11)` (the client's ID for this cancel request) and `OrigClOrdID (41)` (the client's ID for the order being cancelled). The Engine uses its own `OrderID (37)` for routing, not the client IDs — the Gateway will need to use `OrderID (37)` as the key passed to `orderManager.cancel()`. Check whether `OrigOrdID` or `OrderID` is the right FIX field to carry the engine's order ID back from the client. Tag 37 (`OrderID`) is the standard field for this.

**Note on engine-initiated cancels:** `orderManager.place()` already returns `Cancelled` updates (e.g. Market Order with insufficient liquidity) and the Gateway already routes them in the Issue #9 loop. The market-close path goes through `InstrumentRegistry.onOrdersCancelledOnClose` → `OrderManager` clean-up, but the Gateway does not yet listen to that event to send ERs. This wiring needs to be confirmed or added as part of Issue #10.
