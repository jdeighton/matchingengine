import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Gateway } from './gateway.js';
import type { IFixEngine, IFixSession, IMessage, SessionConfig, SessionStatus } from './fix-engine.js';
import { InstrumentRegistry } from '@matchingengine/engine';
import { OrderManager } from '@matchingengine/engine';
import { MarketDataPublisher } from '@matchingengine/engine';
import type { InstrumentDefinition } from '@matchingengine/shared-types';

// ─── Mock FIX session ────────────────────────────────────────────────────────

class MockFixSession extends EventEmitter implements IFixSession {
  constructor(readonly id: string) {
    super();
  }

  /** Test helper: trigger a status transition on this session. */
  simulateStatus(status: SessionStatus): void {
    this.emit('status', status);
  }
}

// ─── Mock FIX engine ─────────────────────────────────────────────────────────

class MockFixEngine implements IFixEngine {
  private readonly sessionMap = new Map<string, MockFixSession>();
  readonly sent: Array<{ sessionId: string; fields: Map<number, string> }> = [];
  readonly sentGroups: Array<{
    sessionId: string;
    header: Map<number, string>;
    groups: Map<number, string>[];
  }> = [];

  start(): void {}
  async stop(): Promise<void> {}
  async *messages(): AsyncIterable<IMessage> {}

  addSession(config: SessionConfig): MockFixSession {
    const id = `${config.senderCompId}-${config.targetCompId}-${config.beginString}`;
    const session = new MockFixSession(id);
    this.sessionMap.set(id, session);
    return session;
  }

  async removeSession(sessionId: string): Promise<void> {
    this.sessionMap.delete(sessionId);
  }

  getSessions(): MockFixSession[] {
    return [...this.sessionMap.values()];
  }

  getSession(sessionId: string): MockFixSession | undefined {
    return this.sessionMap.get(sessionId);
  }

  sendMessage(sessionId: string, fields: Map<number, string>): void {
    this.sent.push({ sessionId, fields });
  }

  sendGroupMessage(
    sessionId: string,
    header: Map<number, string>,
    groups: Map<number, string>[],
  ): void {
    this.sentGroups.push({ sessionId, header, groups });
  }
}

// ─── Mock message ─────────────────────────────────────────────────────────────

function makeMockMessage(
  tags: Record<number, string>,
  sessionId = 'GW-CLI-FIX.4.4',
): IMessage {
  const map = new Map(Object.entries(tags).map(([k, v]) => [Number(k), v]));
  return { sessionId, get: (tag: number) => map.get(tag) };
}

function makeNewOrderMsg(overrides: Record<number, string> = {}, sessionId = 'GW-CLI-FIX.4.4'): IMessage {
  return makeMockMessage({
    35: 'D',      // MsgType = NewOrderSingle
    55: 'CLM26',  // Symbol
    54: '1',      // Side = Buy
    40: '2',      // OrdType = Limit
    38: '10',     // OrderQty
    44: '100.25', // Price
    1:  'ACC1',   // Account
    50: 'TDR1',   // SenderSubID = Trader
    11: 'CO001',  // ClOrdID
    ...overrides,
  }, sessionId);
}

// ─── Shared helpers ───────────────────────────────────────────────────────────

function makeInstrumentDef(overrides?: Partial<InstrumentDefinition>): InstrumentDefinition {
  return {
    symbol: 'CLM26',
    name: 'Crude Light March 2026',
    tickSize: 0.25,
    contractSize: 1000,
    currency: 'USD',
    expiryDate: new Date('2099-12-31'),
    ...overrides,
  };
}

function makeSessionConfig(
  senderCompId: string,
  targetCompId: string,
): SessionConfig {
  return {
    mode: 'server',
    port: 9000,
    senderCompId,
    targetCompId,
    beginString: 'FIX.4.4',
    heartbeatIntervalSecs: 30,
  };
}

function makeSetup() {
  const engine = new MockFixEngine();
  const registry = new InstrumentRegistry();
  const manager = new OrderManager(registry);
  const publisher = new MarketDataPublisher(registry);
  const gateway = new Gateway(engine, manager, publisher, registry);
  return { engine, registry, manager, publisher, gateway };
}

function makeOpenSetup() {
  const setup = makeSetup();
  setup.registry.add(makeInstrumentDef());
  setup.registry.setMarketState('CLM26', 'Open');
  return setup;
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Gateway', () => {
  describe('session disconnect — notifications', () => {
    it('calls OrderManager.onSessionDisconnect when a session disconnects', () => {
      const { engine, manager, gateway } = makeSetup();
      const spy = vi.spyOn(manager, 'onSessionDisconnect');

      gateway.start([makeSessionConfig('GW', 'CLI')]);
      const session = engine.getSessions()[0]!;

      session.simulateStatus('disconnected');

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(session.id);
    });

    it('calls MarketDataPublisher.disconnect when a session disconnects', () => {
      const { engine, publisher, gateway } = makeSetup();
      const spy = vi.spyOn(publisher, 'disconnect');

      gateway.start([makeSessionConfig('GW', 'CLI')]);
      const session = engine.getSessions()[0]!;

      session.simulateStatus('disconnected');

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(session.id);
    });

    it('does not notify when a session goes active', () => {
      const { engine, manager, publisher, gateway } = makeSetup();
      const orderSpy = vi.spyOn(manager, 'onSessionDisconnect');
      const pubSpy = vi.spyOn(publisher, 'disconnect');

      gateway.start([makeSessionConfig('GW', 'CLI')]);
      const session = engine.getSessions()[0]!;

      session.simulateStatus('active');

      expect(orderSpy).not.toHaveBeenCalled();
      expect(pubSpy).not.toHaveBeenCalled();
    });

    it('notifies for a session added after start via addSession', () => {
      const { engine, manager, gateway } = makeSetup();
      const spy = vi.spyOn(manager, 'onSessionDisconnect');

      gateway.start([]);
      gateway.addSession(makeSessionConfig('GW', 'CLI2'));
      const session = engine.getSessions()[0]!;

      session.simulateStatus('disconnected');

      expect(spy).toHaveBeenCalledOnce();
      expect(spy).toHaveBeenCalledWith(session.id);
    });

    it('does not notify after removeSession — handler is cleaned up', () => {
      const { engine, manager, gateway } = makeSetup();
      const spy = vi.spyOn(manager, 'onSessionDisconnect');

      gateway.start([makeSessionConfig('GW', 'CLI')]);
      const session = engine.getSessions()[0]!;
      const sessionId = session.id;

      gateway.removeSession(sessionId);
      session.simulateStatus('disconnected');

      expect(spy).not.toHaveBeenCalled();
    });

    it('handles multiple sessions — each disconnect notifies with its own id', () => {
      const { engine, manager, gateway } = makeSetup();
      const spy = vi.spyOn(manager, 'onSessionDisconnect');

      gateway.start([
        makeSessionConfig('GW', 'CLI-A'),
        makeSessionConfig('GW', 'CLI-B'),
      ]);
      const sessions = engine.getSessions();
      const [sessionA, sessionB] = sessions;

      sessionA!.simulateStatus('disconnected');
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(sessionA!.id);

      sessionB!.simulateStatus('disconnected');
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy).toHaveBeenCalledWith(sessionB!.id);
    });
  });

  // ─── Issue #8: New Order round-trip ─────────────────────────────────────────

  describe('NewOrderSingle — happy path', () => {
    it('sends an Execution Report with OrdStatus=New for a valid resting Limit Order', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeNewOrderMsg());

      expect(engine.sent).toHaveLength(1);
      const { fields } = engine.sent[0]!;
      expect(fields.get(35)).toBe('8');  // ExecutionReport
      expect(fields.get(150)).toBe('0'); // ExecType = New
      expect(fields.get(39)).toBe('0');  // OrdStatus = New
    });

    it('echoes ClOrdID back in the Execution Report', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeNewOrderMsg({ 11: 'MY-ORDER-42' }));

      const { fields } = engine.sent[0]!;
      expect(fields.get(11)).toBe('MY-ORDER-42');
    });

    it('includes Symbol, Side, OrderQty and a non-zero LeavesQty in the Execution Report', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeNewOrderMsg({ 54: '2', 38: '5' })); // Sell, qty=5

      const { fields } = engine.sent[0]!;
      expect(fields.get(55)).toBe('CLM26'); // Symbol
      expect(fields.get(54)).toBe('2');     // Side = Sell
      expect(fields.get(38)).toBe('5');     // OrderQty
      expect(fields.get(14)).toBe('0');     // CumQty = 0 (not filled)
      expect(fields.get(151)).toBe('5');    // LeavesQty = full qty
    });

    it('routes the Execution Report back to the originating session', () => {
      const { engine, gateway } = makeOpenSetup();
      const SESSION = 'GW-CLI-FIX.4.4';

      gateway.handleMessage(makeNewOrderMsg({}, SESSION));

      expect(engine.sent[0]!.sessionId).toBe(SESSION);
    });
  });

  describe('NewOrderSingle — gateway rejections', () => {
    it('sends OrdStatus=Rejected when Symbol is missing', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeNewOrderMsg({ 55: '' })); // empty = missing

      const { fields } = engine.sent[0]!;
      expect(fields.get(35)).toBe('8');
      expect(fields.get(39)).toBe('8'); // Rejected
    });

    it('sends OrdStatus=Rejected when Side is missing', () => {
      const { engine, gateway } = makeOpenSetup();
      const msg = makeMockMessage({ 35: 'D', 55: 'CLM26', 40: '2', 38: '10', 44: '100.25', 1: 'ACC1', 50: 'TDR1', 11: 'CO1' });

      gateway.handleMessage(msg);

      expect(engine.sent[0]!.fields.get(39)).toBe('8');
    });

    it('sends OrdStatus=Rejected when OrdType is missing', () => {
      const { engine, gateway } = makeOpenSetup();
      const msg = makeMockMessage({ 35: 'D', 55: 'CLM26', 54: '1', 38: '10', 44: '100.25', 1: 'ACC1', 50: 'TDR1', 11: 'CO1' });

      gateway.handleMessage(msg);

      expect(engine.sent[0]!.fields.get(39)).toBe('8');
    });

    it('sends OrdStatus=Rejected when Account is missing', () => {
      const { engine, gateway } = makeOpenSetup();
      const msg = makeMockMessage({ 35: 'D', 55: 'CLM26', 54: '1', 40: '2', 38: '10', 44: '100.25', 50: 'TDR1', 11: 'CO1' });

      gateway.handleMessage(msg);

      expect(engine.sent[0]!.fields.get(39)).toBe('8');
    });

    it('sends OrdStatus=Rejected when SenderSubID (trader) is missing', () => {
      const { engine, gateway } = makeOpenSetup();
      const msg = makeMockMessage({ 35: 'D', 55: 'CLM26', 54: '1', 40: '2', 38: '10', 44: '100.25', 1: 'ACC1', 11: 'CO1' });

      gateway.handleMessage(msg);

      expect(engine.sent[0]!.fields.get(39)).toBe('8');
    });

    it('sends OrdStatus=Rejected for an unknown Symbol', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeNewOrderMsg({ 55: 'UNKNOWN' }));

      expect(engine.sent[0]!.fields.get(39)).toBe('8');
    });

    it('sends OrdStatus=Rejected for a Limit Order with an off-tick price', () => {
      const { engine, gateway } = makeOpenSetup(); // tickSize = 0.25

      gateway.handleMessage(makeNewOrderMsg({ 44: '100.30' })); // not a multiple of 0.25

      expect(engine.sent[0]!.fields.get(39)).toBe('8');
    });

    it('accepts a Limit Order price that is exactly on tick', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeNewOrderMsg({ 44: '100.50' })); // 100.50 / 0.25 = 402 ✓

      expect(engine.sent[0]!.fields.get(39)).toBe('0'); // New, not Rejected
    });

    it('sends OrdStatus=Rejected when the Instrument is Closed', () => {
      const { engine, registry, gateway } = makeSetup();
      registry.add(makeInstrumentDef());
      // Instrument starts Closed — do NOT open it

      gateway.handleMessage(makeNewOrderMsg());

      expect(engine.sent[0]!.fields.get(39)).toBe('8');
    });

    it('sends OrdStatus=Rejected when the Instrument is Halted', () => {
      const { engine, registry, gateway } = makeSetup();
      registry.add(makeInstrumentDef());
      registry.setMarketState('CLM26', 'Open');
      registry.setMarketState('CLM26', 'Halted');

      gateway.handleMessage(makeNewOrderMsg());

      expect(engine.sent[0]!.fields.get(39)).toBe('8');
    });
  });

  // ─── Issue #9: Order matching & fill Execution Reports ───────────────────────

  describe('NewOrderSingle — matching', () => {
    const SESSION_A = 'SESSION-A';
    const SESSION_B = 'SESSION-B';

    /** Place a resting limit Buy 10@100.25 from SESSION_A; return its ER. */
    function placeResting(setup: ReturnType<typeof makeOpenSetup>) {
      setup.gateway.handleMessage(makeNewOrderMsg({ 54: '1', 38: '10', 44: '100.25' }, SESSION_A));
      return setup.engine.sent.at(-1)!;
    }

    it('both sessions receive an Execution Report when a Limit Order crosses a resting Limit Order', () => {
      const { engine, gateway } = makeOpenSetup();
      placeResting({ engine, gateway } as any);
      engine.sent.length = 0; // clear the resting-ER

      // Aggressor: Sell 10@100.25 from SESSION_B — full cross
      gateway.handleMessage(makeNewOrderMsg({ 54: '2', 38: '10', 44: '100.25' }, SESSION_B));

      // One ER to each session
      expect(engine.sent).toHaveLength(2);
      const sessions = engine.sent.map((m) => m.sessionId);
      expect(sessions).toContain(SESSION_A);
      expect(sessions).toContain(SESSION_B);
    });

    it('both ERs carry state=Filled on a full cross', () => {
      const { engine, gateway } = makeOpenSetup();
      placeResting({ engine, gateway } as any);
      engine.sent.length = 0;

      gateway.handleMessage(makeNewOrderMsg({ 54: '2', 38: '10', 44: '100.25' }, SESSION_B));

      for (const { fields } of engine.sent) {
        expect(fields.get(39)).toBe('2'); // OrdStatus = Filled
      }
    });

    it('execution price equals the Resting Order price (price improvement for aggressor)', () => {
      const { engine, gateway } = makeOpenSetup();
      placeResting({ engine, gateway } as any);
      engine.sent.length = 0;

      // Aggressor submits at 100.00 (willing to sell for less) — fills at resting price 100.25
      gateway.handleMessage(makeNewOrderMsg({ 54: '2', 38: '10', 44: '100.00' }, SESSION_B));

      for (const { fields } of engine.sent) {
        expect(fields.get(6)).toBe('100.25'); // AvgPx = resting price
      }
    });

    it('aggressor partially fills, resting gets PartiallyFilled when aggressor qty < resting qty', () => {
      const { engine, gateway } = makeOpenSetup();
      placeResting({ engine, gateway } as any); // resting: Buy 10@100.25 SESSION_A
      engine.sent.length = 0;

      // Aggressor: Sell 3@100.25 — fills 3 of the 10 resting
      gateway.handleMessage(makeNewOrderMsg({ 54: '2', 38: '3', 44: '100.25' }, SESSION_B));

      const erA = engine.sent.find((m) => m.sessionId === SESSION_A)!;
      const erB = engine.sent.find((m) => m.sessionId === SESSION_B)!;

      // Aggressor fully filled
      expect(erB.fields.get(39)).toBe('2');   // Filled
      expect(erB.fields.get(14)).toBe('3');   // CumQty
      expect(erB.fields.get(151)).toBe('0');  // LeavesQty

      // Resting partially filled
      expect(erA.fields.get(39)).toBe('1');   // PartiallyFilled
      expect(erA.fields.get(14)).toBe('3');   // CumQty
      expect(erA.fields.get(151)).toBe('7');  // LeavesQty = 10 - 3
    });

    it('resting fully fills and aggressor gets PartiallyFilled when aggressor qty > resting qty', () => {
      const { engine, gateway } = makeOpenSetup();
      placeResting({ engine, gateway } as any); // resting: Buy 10@100.25 SESSION_A
      engine.sent.length = 0;

      // Aggressor: Sell 15@100.25 — resting fills completely, aggressor has 5 left resting
      gateway.handleMessage(makeNewOrderMsg({ 54: '2', 38: '15', 44: '100.25' }, SESSION_B));

      const erA = engine.sent.find((m) => m.sessionId === SESSION_A)!;
      const erB = engine.sent.find((m) => m.sessionId === SESSION_B)!;

      expect(erA.fields.get(39)).toBe('2');   // Filled
      expect(erB.fields.get(39)).toBe('1');   // PartiallyFilled
      expect(erB.fields.get(151)).toBe('5');  // LeavesQty = 15 - 10
    });

    it('Market Order against an empty book produces a Cancelled ER with reason InsufficientLiquidity', () => {
      const { engine, gateway } = makeOpenSetup();

      // Market Sell against empty book
      gateway.handleMessage(makeNewOrderMsg({ 40: '1', 38: '10' })); // OrdType=Market, no price

      expect(engine.sent).toHaveLength(1);
      const { fields } = engine.sent[0]!;
      expect(fields.get(39)).toBe('4');  // Cancelled
      expect(fields.get(58)).toContain('InsufficientLiquidity'); // Text
    });

    it('Market Order with partial liquidity: resting fills, remainder Cancelled', () => {
      const { engine, gateway } = makeOpenSetup();
      placeResting({ engine, gateway } as any); // resting: Buy 10@100.25 SESSION_A
      engine.sent.length = 0;

      // Market Sell 15: fills 10 from resting, remaining 5 cancelled
      gateway.handleMessage(makeNewOrderMsg({ 40: '1', 38: '15', 54: '2' }, SESSION_B));

      const erA = engine.sent.find((m) => m.sessionId === SESSION_A)!;
      const erB = engine.sent.find((m) => m.sessionId === SESSION_B)!;

      // Resting fully filled
      expect(erA.fields.get(39)).toBe('2'); // Filled

      // Aggressor cancelled (remainder after exhausting liquidity)
      expect(erB.fields.get(39)).toBe('4');  // Cancelled
      expect(erB.fields.get(14)).toBe('10'); // CumQty = filled amount
      expect(erB.fields.get(58)).toContain('InsufficientLiquidity');
    });

    it('ER for the Resting Order is sent to the Resting Order session, not the aggressor session', () => {
      const { engine, gateway } = makeOpenSetup();
      placeResting({ engine, gateway } as any);
      engine.sent.length = 0;

      gateway.handleMessage(makeNewOrderMsg({ 54: '2', 38: '10', 44: '100.25' }, SESSION_B));

      const erForResting = engine.sent.find((m) => m.sessionId === SESSION_A);
      expect(erForResting).toBeDefined();
      expect(erForResting!.fields.get(39)).toBe('2'); // Filled — this is the resting side's ER
    });
  });

  // ─── Issue #12: Market Data ─────────────────────────────────────────────────

  describe('MarketDataRequest', () => {
    const SESSION = 'GW-CLI-FIX.4.4';

    function makeMDReqMsg(
      subscriptionType: '0' | '1' | '2',
      symbol = 'CLM26',
      reqId  = 'MD-1',
      sessionId = SESSION,
    ): IMessage {
      return makeMockMessage({
        35:  'V',            // MarketDataRequest
        262: reqId,          // MDReqID
        263: subscriptionType,
        55:  symbol,
      }, sessionId);
    }

    /** Direct helper: create a minimal Order-shaped object for use in publish() calls. */
    function makeOrder(overrides: Partial<{
      id: string; side: 'Buy' | 'Sell'; price: number; quantity: number; filledQuantity: number;
    }> = {}): import('@matchingengine/shared-types').Order {
      return {
        id: 'O1', symbol: 'CLM26', side: 'Buy', type: 'Limit',
        quantity: 10, price: 100.25, account: 'ACC1', trader: 'TDR1',
        state: 'New', filledQuantity: 0, timestamp: 1000,
        ...overrides,
      };
    }

    it('responds with a MarketDataSnapshotFullRefresh (35=W) for a Snapshot request (type=0)', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeMDReqMsg('0'));

      expect(engine.sentGroups).toHaveLength(1);
      expect(engine.sentGroups[0]!.header.get(35)).toBe('W');
    });

    it('Snapshot W contains one group per resting order with correct fields', () => {
      const { engine, gateway } = makeOpenSetup();
      // Place a resting buy
      gateway.handleMessage(makeNewOrderMsg({ 54: '1', 38: '10', 44: '100.25' }));
      engine.sentGroups.length = 0; // clear any sentinel sends

      gateway.handleMessage(makeMDReqMsg('0'));

      const { header, groups } = engine.sentGroups[0]!;
      expect(header.get(55)).toBe('CLM26');   // Symbol in header
      expect(header.get(268)).toBe('1');       // NoMDEntries

      const g = groups[0]!;
      expect(g.get(269)).toBe('0');            // MDEntryType = Bid (Buy)
      expect(g.get(270)).toBe('100.25');       // MDEntryPx
      expect(g.get(271)).toBe('10');           // MDEntrySize = remaining qty
    });

    it('subscription (type=1) sends an opening Snapshot W', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeMDReqMsg('1'));

      expect(engine.sentGroups).toHaveLength(1);
      expect(engine.sentGroups[0]!.header.get(35)).toBe('W');
    });

    it('subscription: OrderAdded event produces incremental X with New action', () => {
      const { engine, publisher, gateway } = makeOpenSetup();
      gateway.handleMessage(makeMDReqMsg('1'));
      engine.sentGroups.length = 0;

      publisher.publish('CLM26', { type: 'OrderAdded', order: makeOrder({ id: 'O1', side: 'Buy', price: 100.25, quantity: 10 }) });

      expect(engine.sentGroups).toHaveLength(1);
      const g = engine.sentGroups[0]!;
      expect(g.header.get(35)).toBe('X');
      expect(g.groups[0]!.get(279)).toBe('0');  // MDUpdateAction = New
      expect(g.groups[0]!.get(269)).toBe('0');  // MDEntryType = Bid
      expect(g.groups[0]!.get(270)).toBe('100.25'); // MDEntryPx
      expect(g.groups[0]!.get(271)).toBe('10');     // MDEntrySize
      expect(g.groups[0]!.get(278)).toBe('O1');     // MDEntryID
    });

    it('subscription: TradeEvent produces incremental X with Trade entry type', () => {
      const { engine, publisher, gateway } = makeOpenSetup();
      gateway.handleMessage(makeMDReqMsg('1'));
      engine.sentGroups.length = 0;

      publisher.publish('CLM26', {
        trade: { symbol: 'CLM26', price: 100.25, quantity: 5, aggressingOrderId: 'O2', restingOrderId: 'O1' },
      });

      const g = engine.sentGroups[0]!;
      expect(g.header.get(35)).toBe('X');
      expect(g.groups[0]!.get(279)).toBe('0');  // New
      expect(g.groups[0]!.get(269)).toBe('2');  // MDEntryType = Trade
      expect(g.groups[0]!.get(270)).toBe('100.25'); // price
      expect(g.groups[0]!.get(271)).toBe('5');      // quantity
    });

    it('subscription: OrderFilled produces incremental X with Delete action and zero size', () => {
      const { engine, publisher, gateway } = makeOpenSetup();
      gateway.handleMessage(makeMDReqMsg('1'));
      engine.sentGroups.length = 0;

      publisher.publish('CLM26', { type: 'OrderFilled', order: makeOrder({ id: 'O1', filledQuantity: 10 }) });

      const g = engine.sentGroups[0]!;
      expect(g.groups[0]!.get(279)).toBe('2');  // Delete
      expect(g.groups[0]!.get(271)).toBe('0');  // MDEntrySize = 0
    });

    it('subscription: OrderPartiallyFilled produces incremental X with Change action and remaining size', () => {
      const { engine, publisher, gateway } = makeOpenSetup();
      gateway.handleMessage(makeMDReqMsg('1'));
      engine.sentGroups.length = 0;

      publisher.publish('CLM26', {
        type: 'OrderPartiallyFilled',
        order: makeOrder({ id: 'O1', quantity: 10, filledQuantity: 3 }),
      });

      const g = engine.sentGroups[0]!;
      expect(g.groups[0]!.get(279)).toBe('1');  // Change
      expect(g.groups[0]!.get(271)).toBe('7');  // MDEntrySize = remaining = 10 - 3
    });

    it('subscription: OrderCancelled produces incremental X with Delete action', () => {
      const { engine, publisher, gateway } = makeOpenSetup();
      gateway.handleMessage(makeMDReqMsg('1'));
      engine.sentGroups.length = 0;

      publisher.publish('CLM26', { type: 'OrderCancelled', order: makeOrder({ id: 'O1' }) });

      const g = engine.sentGroups[0]!;
      expect(g.groups[0]!.get(279)).toBe('2');  // Delete
    });

    it('unsubscribe (type=2) stops incremental updates for that Symbol', () => {
      const { engine, publisher, gateway } = makeOpenSetup();
      gateway.handleMessage(makeMDReqMsg('1'));        // subscribe
      gateway.handleMessage(makeMDReqMsg('2'));        // unsubscribe
      engine.sentGroups.length = 0;

      publisher.publish('CLM26', { type: 'OrderAdded', order: makeOrder() });

      expect(engine.sentGroups).toHaveLength(0);
    });

    it('a session can hold subscriptions to two instruments and receives independent updates', () => {
      const { engine, registry, publisher, gateway } = makeSetup();
      registry.add(makeInstrumentDef({ symbol: 'CLM26' }));
      registry.add(makeInstrumentDef({ symbol: 'CLZ26' }));

      gateway.handleMessage(makeMDReqMsg('1', 'CLM26'));
      gateway.handleMessage(makeMDReqMsg('1', 'CLZ26'));
      engine.sentGroups.length = 0;

      publisher.publish('CLM26', { type: 'OrderAdded', order: { ...makeOrder(), symbol: 'CLM26' } });

      expect(engine.sentGroups).toHaveLength(1);
      expect(engine.sentGroups[0]!.groups[0]!.get(55)).toBe('CLM26');
    });

    it('no incremental X after session disconnects', () => {
      const { engine, publisher, gateway } = makeOpenSetup();
      gateway.start([makeSessionConfig('GW', 'CLI')]);
      const session = engine.getSessions()[0]!;
      gateway.handleMessage(makeMDReqMsg('1', 'CLM26', 'MD-1', session.id));
      engine.sentGroups.length = 0;

      session.simulateStatus('disconnected'); // triggers publisher.disconnect()

      publisher.publish('CLM26', { type: 'OrderAdded', order: makeOrder() });

      expect(engine.sentGroups).toHaveLength(0);
    });

    it('end-to-end: subscribe then place a resting Limit Order → incremental OrderAdded X is delivered', () => {
      const { engine, gateway } = makeOpenSetup();
      gateway.handleMessage(makeMDReqMsg('1')); // subscribe
      engine.sentGroups.length = 0;            // clear the opening snapshot

      // Place a new resting Buy — handleNewOrder must publish the OrderAdded event
      gateway.handleMessage(makeNewOrderMsg({ 54: '1', 38: '5', 44: '100.25' }));

      // At least one incremental X should have been sent
      const xMessages = engine.sentGroups.filter(g => g.header.get(35) === 'X');
      expect(xMessages.length).toBeGreaterThan(0);

      const addedMsg = xMessages.find(g => g.groups[0]!.get(279) === '0'); // New action
      expect(addedMsg).toBeDefined();
      expect(addedMsg!.groups[0]!.get(271)).toBe('5');    // MDEntrySize = qty
      expect(addedMsg!.groups[0]!.get(270)).toBe('100.25'); // MDEntryPx
    });

    it('snapshot-only (type=0): no incremental X sent when events are published after the snapshot', () => {
      const { engine, publisher, gateway } = makeOpenSetup();

      gateway.handleMessage(makeMDReqMsg('0')); // snapshot-only
      engine.sentGroups.length = 0;

      // Publish an event — should NOT trigger an X since we unsubscribed
      publisher.publish('CLM26', { type: 'OrderAdded', order: makeOrder() });

      expect(engine.sentGroups).toHaveLength(0); // no incremental
    });

    it('Snapshot W echoes MDReqID', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeMDReqMsg('0', 'CLM26', 'MY-REQ-42'));

      expect(engine.sentGroups[0]!.header.get(262)).toBe('MY-REQ-42');
    });
  });

  // ─── Issue #11: Reference Data ──────────────────────────────────────────────

  describe('SecurityListRequest', () => {
    function makeSecurityListReqMsg(overrides: Record<number, string> = {}, sessionId = 'GW-CLI-FIX.4.4'): IMessage {
      return makeMockMessage({
        35: 'x',       // MsgType = SecurityListRequest
        320: 'REQ-1',  // SecurityReqID
        ...overrides,
      }, sessionId);
    }

    it('responds with a SecurityList (MsgType=y) when a SecurityListRequest is received', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeSecurityListReqMsg());

      expect(engine.sentGroups).toHaveLength(1);
      expect(engine.sentGroups[0]!.header.get(35)).toBe('y'); // SecurityList
    });

    it('returns an empty SecurityList (0 groups) when no Instruments are registered', () => {
      const { engine, gateway } = makeSetup(); // empty registry — no instruments added

      gateway.handleMessage(makeSecurityListReqMsg());

      expect(engine.sentGroups).toHaveLength(1); // response sent, not an error
      const { header, groups } = engine.sentGroups[0]!;
      expect(groups).toHaveLength(0);
      expect(header.get(146)).toBe('0'); // NoRelatedSym = 0
      expect(header.get(560)).toBe('0'); // SecurityRequestResult = valid
    });

    it('each group carries Symbol, name, tick size, contract size, currency, and expiry date', () => {
      const { engine, registry, gateway } = makeSetup();
      registry.add(makeInstrumentDef({
        symbol: 'CLM26',
        name: 'Crude Light March 2026',
        tickSize: 0.25,
        contractSize: 1000,
        currency: 'USD',
        expiryDate: new Date('2026-03-31'),
      }));

      gateway.handleMessage(makeSecurityListReqMsg());

      const group = engine.sentGroups[0]!.groups[0]!;
      expect(group.get(55)).toBe('CLM26');           // Symbol
      expect(group.get(107)).toBe('Crude Light March 2026'); // SecurityDesc = name
      expect(group.get(15)).toBe('USD');             // Currency
      expect(group.get(231)).toBe('1000');           // ContractMultiplier = contract size
      expect(group.get(541)).toBe('20260331');       // MaturityDate = expiry (YYYYMMDD)
      expect(group.get(969)).toBe('0.25');           // MinPriceIncrement = tick size
    });

    it('response contains one group per registered Instrument and NoRelatedSym matches', () => {
      const { engine, registry, gateway } = makeSetup();
      registry.add(makeInstrumentDef({ symbol: 'CLM26' }));
      registry.add(makeInstrumentDef({ symbol: 'CLZ26' }));

      gateway.handleMessage(makeSecurityListReqMsg());

      const { header, groups } = engine.sentGroups[0]!;
      expect(groups).toHaveLength(2);
      expect(header.get(146)).toBe('2'); // NoRelatedSym
      const symbols = groups.map(g => g.get(55));
      expect(symbols).toContain('CLM26');
      expect(symbols).toContain('CLZ26');
    });

    it('echoes the SecurityReqID from the request in the response header', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeSecurityListReqMsg({ 320: 'MY-REQUEST-42' }));

      expect(engine.sentGroups[0]!.header.get(320)).toBe('MY-REQUEST-42');
    });

    it('routes the SecurityList response to the Session that sent the request', () => {
      const { engine, gateway } = makeOpenSetup();
      const SESSION = 'SOME-SESSION';

      gateway.handleMessage(makeSecurityListReqMsg({}, SESSION));

      expect(engine.sentGroups[0]!.sessionId).toBe(SESSION);
    });
  });

  // ─── Issue #10: Cancellation Request flow ───────────────────────────────────

  describe('OrderCancelRequest', () => {
    const SESSION_A = 'SESSION-A';
    const SESSION_B = 'SESSION-B';

    function makeCancelMsg(
      orderId: string,
      overrides: Record<number, string> = {},
      sessionId = SESSION_A,
    ): IMessage {
      return makeMockMessage({
        35: 'F',       // MsgType = OrderCancelRequest
        37: orderId,   // OrderID (engine's internal ID)
        11: 'CXL-001', // ClOrdID of this cancel request
        55: 'CLM26',   // Symbol
        54: '1',       // Side = Buy
        ...overrides,
      }, sessionId);
    }

    it('sends a Cancelled ER when the client cancels its own resting Order', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeNewOrderMsg({}, SESSION_A));
      const orderId = engine.sent.at(-1)!.fields.get(37)!;
      engine.sent.length = 0;

      gateway.handleMessage(makeCancelMsg(orderId));

      expect(engine.sent).toHaveLength(1);
      expect(engine.sent[0]!.sessionId).toBe(SESSION_A);
      expect(engine.sent[0]!.fields.get(39)).toBe('4');  // Cancelled
      expect(engine.sent[0]!.fields.get(150)).toBe('4'); // ExecType = Cancelled
    });

    it('Cancelled ER for a partially-filled Order carries CumQty equal to the filled amount', () => {
      const { engine, gateway } = makeOpenSetup();

      // Place resting Buy 10@100.25 from SESSION_A
      gateway.handleMessage(makeNewOrderMsg({ 54: '1', 38: '10', 44: '100.25' }, SESSION_A));
      const restingOrderId = engine.sent.at(-1)!.fields.get(37)!;

      // Aggressor Sell 3@100.25 from SESSION_B — partially fills the resting order
      gateway.handleMessage(makeNewOrderMsg({ 54: '2', 38: '3', 44: '100.25' }, SESSION_B));
      engine.sent.length = 0;

      // Now cancel the partially-filled resting order
      gateway.handleMessage(makeCancelMsg(restingOrderId));

      const { fields } = engine.sent[0]!;
      expect(fields.get(39)).toBe('4');   // Cancelled
      expect(fields.get(38)).toBe('10');  // OrderQty = original 10
      expect(fields.get(14)).toBe('3');   // CumQty = 3 (filled so far)
      expect(fields.get(151)).toBe('0');  // LeavesQty = 0 (cancelled)
    });

    it('sends a Cancelled ER to the originating Session when the market closes with resting Orders', () => {
      const { engine, registry, gateway } = makeOpenSetup();

      // Place two resting orders from different sessions
      gateway.handleMessage(makeNewOrderMsg({ 54: '1', 38: '10', 44: '100.25' }, SESSION_A));
      gateway.handleMessage(makeNewOrderMsg({ 54: '1', 38: '5',  44: '100.00' }, SESSION_B));
      engine.sent.length = 0;

      // Close the market — engine cancels all resting orders
      registry.setMarketState('CLM26', 'Closed');

      expect(engine.sent).toHaveLength(2); // one ER per resting order

      const erA = engine.sent.find(m => m.sessionId === SESSION_A)!;
      const erB = engine.sent.find(m => m.sessionId === SESSION_B)!;

      expect(erA).toBeDefined();
      expect(erA.fields.get(39)).toBe('4');  // Cancelled
      expect(erA.fields.get(38)).toBe('10'); // OrderQty

      expect(erB).toBeDefined();
      expect(erB.fields.get(39)).toBe('4');  // Cancelled
      expect(erB.fields.get(38)).toBe('5');  // OrderQty
    });

    it('sends a Rejected ER with reason CannotCancelFilledOrder when the Order is already Filled', () => {
      const { engine, gateway } = makeOpenSetup();

      // Place a resting Buy 10@100.25 from SESSION_A
      gateway.handleMessage(makeNewOrderMsg({ 54: '1', 38: '10', 44: '100.25' }, SESSION_A));
      const orderId = engine.sent.at(-1)!.fields.get(37)!;

      // Fully fill it by agressing from SESSION_B
      gateway.handleMessage(makeNewOrderMsg({ 54: '2', 38: '10', 44: '100.25' }, SESSION_B));
      engine.sent.length = 0;

      // Attempt to cancel the now-Filled order from SESSION_A
      gateway.handleMessage(makeCancelMsg(orderId));

      expect(engine.sent).toHaveLength(1);
      expect(engine.sent[0]!.fields.get(39)).toBe('8');                  // Rejected
      expect(engine.sent[0]!.fields.get(58)).toBe('CannotCancelFilledOrder'); // Text
    });

    it('sends a Rejected ER for an unknown Order ID', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeCancelMsg('ORDER-DOES-NOT-EXIST'));

      expect(engine.sent).toHaveLength(1);
      expect(engine.sent[0]!.sessionId).toBe(SESSION_A);
      expect(engine.sent[0]!.fields.get(39)).toBe('8'); // Rejected
    });

    it('sends a Rejected ER when a cancel request comes from a different Session', () => {
      const { engine, gateway } = makeOpenSetup();

      gateway.handleMessage(makeNewOrderMsg({}, SESSION_A));
      const orderId = engine.sent.at(-1)!.fields.get(37)!;
      engine.sent.length = 0;

      // SESSION_B tries to cancel SESSION_A's order
      gateway.handleMessage(makeCancelMsg(orderId, {}, SESSION_B));

      expect(engine.sent).toHaveLength(1);
      expect(engine.sent[0]!.sessionId).toBe(SESSION_B); // Rejected ER goes to requester
      expect(engine.sent[0]!.fields.get(39)).toBe('8');  // Rejected
    });

    it('Cancelled ER echoes OrderID, ClOrdID, Symbol, Side and carries correct quantities', () => {
      const { engine, gateway } = makeOpenSetup();

      // Place a resting Buy 10@100.25
      gateway.handleMessage(makeNewOrderMsg({ 54: '1', 38: '10', 44: '100.25', 11: 'ORD-ORIG' }, SESSION_A));
      const orderId = engine.sent.at(-1)!.fields.get(37)!;
      engine.sent.length = 0;

      gateway.handleMessage(makeCancelMsg(orderId, { 11: 'CXL-42' }));

      const { fields } = engine.sent[0]!;
      expect(fields.get(37)).toBe(orderId);       // OrderID echoed
      expect(fields.get(11)).toBe('CXL-42');       // ClOrdID = cancel request's ClOrdID
      expect(fields.get(55)).toBe('CLM26');        // Symbol
      expect(fields.get(54)).toBe('1');            // Side = Buy
      expect(fields.get(38)).toBe('10');           // OrderQty = original qty
      expect(fields.get(14)).toBe('0');            // CumQty = 0 (unfilled resting order)
      expect(fields.get(151)).toBe('0');           // LeavesQty = 0 (terminal)
    });
  });

  // ─── Session management: getSessions / hasSession ──────────────────────────

  describe('session management', () => {
    it('addSession returns the session id', () => {
      const { gateway } = makeSetup();
      gateway.start([]);
      const id = gateway.addSession(makeSessionConfig('GW', 'CLI'));
      expect(id).toBe('GW-CLI-FIX.4.4');
    });

    it('getSessions returns added sessions with inactive status initially', () => {
      const { gateway } = makeSetup();
      gateway.start([makeSessionConfig('GW', 'CLI')]);
      const sessions = gateway.getSessions();
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toEqual({ sessionId: 'GW-CLI-FIX.4.4', status: 'inactive' });
    });

    it('getSessions reflects active status after session goes active', () => {
      const { engine, gateway } = makeSetup();
      gateway.start([makeSessionConfig('GW', 'CLI')]);
      const session = engine.getSessions()[0] as MockFixSession;
      session.simulateStatus('active');
      const sessions = gateway.getSessions();
      expect(sessions[0]!.status).toBe('active');
    });

    it('getSessions reflects inactive status after session disconnects', () => {
      const { engine, gateway } = makeSetup();
      gateway.start([makeSessionConfig('GW', 'CLI')]);
      const session = engine.getSessions()[0] as MockFixSession;
      session.simulateStatus('active');
      session.simulateStatus('disconnected');
      const sessions = gateway.getSessions();
      expect(sessions[0]!.status).toBe('inactive');
    });

    it('hasSession returns true for a configured session', () => {
      const { gateway } = makeSetup();
      gateway.start([makeSessionConfig('GW', 'CLI')]);
      expect(gateway.hasSession('GW-CLI-FIX.4.4')).toBe(true);
    });

    it('hasSession returns false for an unknown session', () => {
      const { gateway } = makeSetup();
      gateway.start([]);
      expect(gateway.hasSession('NOBODY')).toBe(false);
    });

    it('hasSession returns false after removeSession', async () => {
      const { gateway } = makeSetup();
      gateway.start([makeSessionConfig('GW', 'CLI')]);
      await gateway.removeSession('GW-CLI-FIX.4.4');
      expect(gateway.hasSession('GW-CLI-FIX.4.4')).toBe(false);
    });
  });
});
