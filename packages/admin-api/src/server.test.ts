import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { InstrumentRegistry } from '@matchingengine/engine';
import { buildServer } from './server.js';
import type { IGatewayAdmin, SessionInfo, SessionRequest } from './gateway-admin.js';
import { Scheduler } from './scheduler.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeRegistry(): InstrumentRegistry {
  return new InstrumentRegistry();
}

const VALID_BODY = {
  symbol: 'ESZ4',
  name: 'E-mini S&P 500 Dec 2024',
  tickSize: 0.25,
  contractSize: 50,
  currency: 'USD',
  expiryDate: '2024-12-20',
};

// ─── Shared setup helper ──────────────────────────────────────────────────────

async function seedInstrument(app: ReturnType<typeof buildServer>, body = VALID_BODY) {
  await app.inject({ method: 'POST', url: '/instruments', payload: body });
}

// ─── DELETE /instruments/:symbol ─────────────────────────────────────────────

describe('DELETE /instruments/:symbol', () => {
  it('delists instrument and returns 204', async () => {
    const app = buildServer(makeRegistry());
    await seedInstrument(app);
    const res = await app.inject({ method: 'DELETE', url: '/instruments/ESZ4' });
    expect(res.statusCode).toBe(204);
  });

  it('returns 404 for unknown symbol', async () => {
    const app = buildServer(makeRegistry());
    const res = await app.inject({ method: 'DELETE', url: '/instruments/UNKNOWN' });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('not found');
  });
});

// ─── GET /instruments ─────────────────────────────────────────────────────────

describe('GET /instruments', () => {
  it('returns all instruments with symbol and marketState', async () => {
    const app = buildServer(makeRegistry());
    await seedInstrument(app);
    await seedInstrument(app, { ...VALID_BODY, symbol: 'NQZ4', name: 'Nasdaq Dec 2024' });
    const res = await app.inject({ method: 'GET', url: '/instruments' });
    expect(res.statusCode).toBe(200);
    const list = res.json() as { symbol: string; marketState: string }[];
    expect(list).toHaveLength(2);
    const symbols = list.map((i) => i.symbol).sort();
    expect(symbols).toEqual(['ESZ4', 'NQZ4']);
    for (const item of list) {
      expect(item.marketState).toBe('Closed');
    }
  });

  it('returns empty array when no instruments are registered', async () => {
    const app = buildServer(makeRegistry());
    const res = await app.inject({ method: 'GET', url: '/instruments' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

// ─── Market State transitions ─────────────────────────────────────────────────

describe('Market State transitions', () => {
  it('POST /open transitions Closed → Open and returns 200', async () => {
    const app = buildServer(makeRegistry());
    await seedInstrument(app);
    const res = await app.inject({ method: 'POST', url: '/instruments/ESZ4/open' });
    expect(res.statusCode).toBe(200);
    expect(res.json().marketState).toBe('Open');
  });

  it('POST /halt transitions Open → Halted and returns 200', async () => {
    const app = buildServer(makeRegistry());
    await seedInstrument(app);
    await app.inject({ method: 'POST', url: '/instruments/ESZ4/open' });
    const res = await app.inject({ method: 'POST', url: '/instruments/ESZ4/halt' });
    expect(res.statusCode).toBe(200);
    expect(res.json().marketState).toBe('Halted');
  });

  it('POST /resume transitions Halted → Open and returns 200', async () => {
    const app = buildServer(makeRegistry());
    await seedInstrument(app);
    await app.inject({ method: 'POST', url: '/instruments/ESZ4/open' });
    await app.inject({ method: 'POST', url: '/instruments/ESZ4/halt' });
    const res = await app.inject({ method: 'POST', url: '/instruments/ESZ4/resume' });
    expect(res.statusCode).toBe(200);
    expect(res.json().marketState).toBe('Open');
  });

  it('POST /close transitions Open → Closed and returns 200', async () => {
    const app = buildServer(makeRegistry());
    await seedInstrument(app);
    await app.inject({ method: 'POST', url: '/instruments/ESZ4/open' });
    const res = await app.inject({ method: 'POST', url: '/instruments/ESZ4/close' });
    expect(res.statusCode).toBe(200);
    expect(res.json().marketState).toBe('Closed');
  });

  it('invalid transition returns 409 with currentState and requestedState', async () => {
    const app = buildServer(makeRegistry());
    await seedInstrument(app);
    // Instrument starts Closed; trying to halt from Closed is invalid
    const res = await app.inject({ method: 'POST', url: '/instruments/ESZ4/halt' });
    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.currentState).toBe('Closed');
    expect(body.requestedState).toBe('Halted');
  });

  it('returns 404 for unknown symbol on state transition', async () => {
    const app = buildServer(makeRegistry());
    const res = await app.inject({ method: 'POST', url: '/instruments/UNKNOWN/open' });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /instruments/:symbol/schedule ──────────────────────────────────────

describe('POST /instruments/:symbol/schedule', () => {
  it('stores open/close schedule and returns 200', async () => {
    const app = buildServer(makeRegistry());
    await seedInstrument(app);
    const res = await app.inject({
      method: 'POST',
      url: '/instruments/ESZ4/schedule',
      payload: { openTime: '08:30', closeTime: '15:00' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.schedule.openTime).toBe('08:30');
    expect(body.schedule.closeTime).toBe('15:00');
  });

  it('returns 422 when openTime/closeTime are missing or malformed', async () => {
    const app = buildServer(makeRegistry());
    await seedInstrument(app);
    const res = await app.inject({
      method: 'POST',
      url: '/instruments/ESZ4/schedule',
      payload: { openTime: 'not-a-time' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().details.length).toBeGreaterThan(0);
  });

  it('returns 404 for unknown symbol', async () => {
    const app = buildServer(makeRegistry());
    const res = await app.inject({
      method: 'POST',
      url: '/instruments/UNKNOWN/schedule',
      payload: { openTime: '08:30', closeTime: '15:00' },
    });
    expect(res.statusCode).toBe(404);
  });
});

// ─── POST /instruments ────────────────────────────────────────────────────────

describe('POST /instruments', () => {
  it('adds instrument with valid body and returns 201', async () => {
    const app = buildServer(makeRegistry());
    const res = await app.inject({
      method: 'POST',
      url: '/instruments',
      payload: VALID_BODY,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.symbol).toBe('ESZ4');
    expect(body.marketState).toBe('Closed');
  });

  it('returns 409 when symbol already exists', async () => {
    const app = buildServer(makeRegistry());
    await app.inject({ method: 'POST', url: '/instruments', payload: VALID_BODY });
    const res = await app.inject({ method: 'POST', url: '/instruments', payload: VALID_BODY });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('already exists');
  });

  it('returns 422 when required fields are missing', async () => {
    const app = buildServer(makeRegistry());
    const res = await app.inject({
      method: 'POST',
      url: '/instruments',
      payload: { symbol: 'X' },   // missing name, tickSize, contractSize, currency, expiryDate
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().details.length).toBeGreaterThan(0);
  });

  it('returns 422 when tickSize is zero', async () => {
    const app = buildServer(makeRegistry());
    const res = await app.inject({
      method: 'POST',
      url: '/instruments',
      payload: { ...VALID_BODY, tickSize: 0 },
    });
    expect(res.statusCode).toBe(422);
  });
});

// ─── Session management ───────────────────────────────────────────────────────

class MockGateway implements IGatewayAdmin {
  private readonly sessions = new Map<string, SessionInfo>();

  addSession(req: SessionRequest): string {
    const beginString = req.beginString ?? 'FIX.4.4';
    const sessionId = `${req.senderCompId}-${req.targetCompId}-${beginString}`;
    this.sessions.set(sessionId, { sessionId, status: 'inactive' });
    return sessionId;
  }

  async removeSession(sessionId: string): Promise<void> {
    this.sessions.delete(sessionId);
  }

  getSessions(): SessionInfo[] {
    return [...this.sessions.values()];
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  /** Test helper: force a session's status. */
  setStatus(sessionId: string, status: 'active' | 'inactive'): void {
    const info = this.sessions.get(sessionId);
    if (info) info.status = status;
  }
}

const VALID_SESSION = {
  senderCompId: 'EXCHANGE',
  targetCompId: 'CLIENT1',
  port: 9001,
};

describe('POST /sessions', () => {
  it('adds session with valid body and returns 201 with sessionId', async () => {
    const gw = new MockGateway();
    const app = buildServer(makeRegistry(), gw);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      payload: VALID_SESSION,
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.sessionId).toBe('EXCHANGE-CLIENT1-FIX.4.4');
    expect(body.status).toBe('inactive');
  });

  it('returns 409 when session already exists', async () => {
    const gw = new MockGateway();
    const app = buildServer(makeRegistry(), gw);
    await app.inject({ method: 'POST', url: '/sessions', payload: VALID_SESSION });
    const res = await app.inject({ method: 'POST', url: '/sessions', payload: VALID_SESSION });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toContain('already exists');
  });

  it('returns 422 when required fields are missing', async () => {
    const gw = new MockGateway();
    const app = buildServer(makeRegistry(), gw);
    const res = await app.inject({
      method: 'POST',
      url: '/sessions',
      payload: { senderCompId: 'EXCHANGE' },  // missing targetCompId and port
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().details.length).toBeGreaterThan(0);
  });
});

describe('DELETE /sessions/:sessionId', () => {
  it('removes the session and returns 204', async () => {
    const gw = new MockGateway();
    const app = buildServer(makeRegistry(), gw);
    await app.inject({ method: 'POST', url: '/sessions', payload: VALID_SESSION });
    const res = await app.inject({
      method: 'DELETE',
      url: '/sessions/EXCHANGE-CLIENT1-FIX.4.4',
    });
    expect(res.statusCode).toBe(204);
    expect(gw.hasSession('EXCHANGE-CLIENT1-FIX.4.4')).toBe(false);
  });

  it('returns 404 for an unknown session ID', async () => {
    const gw = new MockGateway();
    const app = buildServer(makeRegistry(), gw);
    const res = await app.inject({
      method: 'DELETE',
      url: '/sessions/NOBODY',
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('not found');
  });
});

describe('GET /sessions', () => {
  it('returns all sessions with their connection status', async () => {
    const gw = new MockGateway();
    const app = buildServer(makeRegistry(), gw);
    await app.inject({ method: 'POST', url: '/sessions', payload: VALID_SESSION });
    await app.inject({ method: 'POST', url: '/sessions', payload: { ...VALID_SESSION, targetCompId: 'CLIENT2' } });
    gw.setStatus('EXCHANGE-CLIENT1-FIX.4.4', 'active');

    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    const list = res.json() as SessionInfo[];
    expect(list).toHaveLength(2);
    const active = list.find((s) => s.sessionId === 'EXCHANGE-CLIENT1-FIX.4.4');
    const inactive = list.find((s) => s.sessionId === 'EXCHANGE-CLIENT2-FIX.4.4');
    expect(active?.status).toBe('active');
    expect(inactive?.status).toBe('inactive');
  });

  it('returns empty array when no sessions are configured', async () => {
    const gw = new MockGateway();
    const app = buildServer(makeRegistry(), gw);
    const res = await app.inject({ method: 'GET', url: '/sessions' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

// ─── Scheduler wiring ─────────────────────────────────────────────────────────
// These tests verify that buildServer correctly delegates to the Scheduler.
// The actual timer / firing behaviour is covered exhaustively in scheduler.test.ts.

describe('Scheduler wiring via buildServer', () => {
  it('POST /instruments/:symbol/schedule calls scheduler.setSchedule', async () => {
    const registry  = makeRegistry();
    const scheduler = new Scheduler(registry);
    const spy       = vi.spyOn(scheduler, 'setSchedule');
    const app       = buildServer(registry, undefined, scheduler);

    await app.inject({ method: 'POST', url: '/instruments', payload: VALID_BODY });
    const res = await app.inject({
      method: 'POST',
      url: '/instruments/ESZ4/schedule',
      payload: { openTime: '08:30', closeTime: '15:00' },
    });

    expect(res.statusCode).toBe(200);
    expect(spy).toHaveBeenCalledWith('ESZ4', '08:30', '15:00');
  });

  it('DELETE /instruments/:symbol calls scheduler.cancelSchedule', async () => {
    const registry  = makeRegistry();
    const scheduler = new Scheduler(registry);
    const spy       = vi.spyOn(scheduler, 'cancelSchedule');
    const app       = buildServer(registry, undefined, scheduler);

    await app.inject({ method: 'POST', url: '/instruments', payload: VALID_BODY });
    await app.inject({ method: 'DELETE', url: '/instruments/ESZ4' });

    expect(spy).toHaveBeenCalledWith('ESZ4');
  });
});
