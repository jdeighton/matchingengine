# Market data request rejects use 35=Y (MarketDataRequestReject)

When a MarketDataRequest arrives for an unknown symbol, the Gateway sends `35=Y` (MarketDataRequestReject) rather than propagating an unhandled exception. The original implementation called `registry.getSnapshot(symbol)` without guarding against an unknown symbol, causing the async message loop to crash. Fixed to catch the unknown-symbol case and respond with the standard FIX reject message, consistent with the same principle applied to cancel rejects (ADR-0002).
