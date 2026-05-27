I want to create a matching engine to use as an internal platform for testing various electronic trading tools.  Being able to control the behavior and understanding the operation of the platform are key design goals.  Performance is not a concern as the expected message rates will be low.

I want to have the engine and supporting services written in node.js using typescript, and I'd like to wrap a web based administration tool around the whole thing (probably based on Fastily, React and Vite).  

Features I expect the matching engine to have in the initial version: 
- Support for market and limit orders (other order types may be added later, but these are needed in version one)
- FIFO matching rules, orders have price and then time priority.
- If a match between limit orders results in a price improvement, the agressing order should receive the price improvement.
- Regarding orders - the matching engine should accept new order messages and order cancellation messages only initially.  Later we may add support for cancel/replace as a single step, but not in version 1.
- The engine should also be capable of generating market data updates.  Clients should be able to request a one time snapshot of the book, or request a snapshot and subscribe to updates.  Snapshots should send the whole book as one message with the details included.  Unsure currently whether to provide aggregated volume at each prive level, or to provide order-by-order level updates and allow clients to assemble these into a representation of the order book.  We should review this in more depth considering complexity, ease of use and potential changes to the architecture.  The market data should also allow complted trades to be published so that the clients know what has been matched (should include price and quantity as well as symbol).
- The engine should support multiple products at once. The products will be modelled after Futures products, including the concept of tick sizes vs a more typical equity decimal price.
- The engine should allow clients to discover the available products (some sort of instrument definition download).
- It is expected that interaction with the engine by clients is done via FIX 4.4, and that there will be some sort of validation gateway that will convert between the FIX format and the internal representations.

The web based administration portal should provide means to do the follwoing actions:
- Start/stop a market manually and on a schedule.  Query what happens to open orders when the market closes.
- Add new products
- Manage connectivity points for new clients (setting up FIX listeners and ports).

For the FIX engine, this can be based off a recently developed library found here: @D:\NextCloud\src\fixserver

Other miscellaneous thoughts and questions:
- Orders must have an account associated with them (from FIX tag 1), and a trader identifier (from FIX tag 50).
- What would be suitable identifiers for clients so we can track who to update when an order fills?  Do we use the sender/target comp ID pairs or assign an internal identifier or mapping on the gateway level or in the admin portal?
- What are the smallest set of order statuses that we can use to start? 
- We'll need to track who is subscribed for market data and allow them to cancel that subscription when necessary.
- If a market order is sent and there is insufficient quantity to fill it, the balance should be cancelled (should include a message so the client knows why it was not fully filled)
- What differences would we have in the required FIX tags to make the matching engine work that are not already required in the QuickFIX 4.4 specification?

