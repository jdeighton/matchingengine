# Cancel rejects use 35=9 (OrderCancelReject), not 35=8

When a client's Cancellation Request is rejected (order already filled, cross-session attempt, missing OrderID), the Gateway sends `35=9` (OrderCancelReject) rather than a `35=8` (ExecutionReport) with a non-Cancelled status. The original implementation returned `35=8` for all cancel outcomes. Changed to align with FIX 4.4 standard, which reserves `35=8` for order state transitions and uses `35=9` specifically for cancel refusals. This makes the distinction unambiguous for any FIX client: `35=9` always means "your cancel was refused; the order state is unchanged."

## Considered options

- Leave `35=8` for all cancel outcomes and detect rejection in clients from `OrdStatus ≠ 4`. Rejected: non-standard, forces every client to implement custom detection logic.
