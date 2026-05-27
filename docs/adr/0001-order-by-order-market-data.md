# Order-by-order Market Data delivery

Market Data is delivered at the individual Order level rather than as aggregated price-level depth. Each Order Book update identifies a specific Order (add, fill, cancel), not a net change to a price level's total quantity.

This was a deliberate choice for a testing platform where full visibility into queue position and priority is a primary goal. Aggregated depth hides how many Orders sit at a price level and their relative priority — exactly the information needed to test how trading tools respond to queue dynamics. Aggregated views can always be derived from order-by-order data; the reverse is impossible.
