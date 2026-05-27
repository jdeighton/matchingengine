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
});
