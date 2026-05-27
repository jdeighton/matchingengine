import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import type { InstrumentRegistry } from '@matchingengine/engine';
import type { MarketState } from '@matchingengine/shared-types';
import type { IGatewayAdmin } from './gateway-admin.js';
import type { Scheduler } from './scheduler.js';

// ─── Schedule store (consumed by Scheduler in Issue #15) ─────────────────────

export interface ScheduleEntry {
  openTime: string;
  closeTime: string;
}

// ─── Server factory ───────────────────────────────────────────────────────────

export function buildServer(
  registry: InstrumentRegistry,
  gateway?: IGatewayAdmin,
  scheduler?: Scheduler,
): FastifyInstance {
  const app = Fastify({ logger: false });

  const schedules = new Map<string, ScheduleEntry>();

  // ── POST /instruments ──────────────────────────────────────────────────────

  app.post('/instruments', async (request, reply) => {
    const body = request.body as Record<string, unknown>;

    // Validate required fields
    const errors: string[] = [];
    const requiredStrings = ['symbol', 'name', 'currency', 'expiryDate'] as const;
    for (const field of requiredStrings) {
      if (typeof body[field] !== 'string' || (body[field] as string).trim() === '') {
        errors.push(`${field} is required and must be a non-empty string`);
      }
    }
    const requiredNumbers = ['tickSize', 'contractSize'] as const;
    for (const field of requiredNumbers) {
      if (typeof body[field] !== 'number' || (body[field] as number) <= 0) {
        errors.push(`${field} is required and must be a positive number`);
      }
    }
    // Validate expiryDate is a parseable date string
    if (typeof body['expiryDate'] === 'string') {
      const parsed = new Date(body['expiryDate'] as string);
      if (isNaN(parsed.getTime())) {
        errors.push('expiryDate must be a valid ISO date string');
      }
    }

    if (errors.length > 0) {
      return reply.status(422).send({ error: 'Validation failed', details: errors });
    }

    const symbol = (body['symbol'] as string).trim();

    try {
      registry.add({
        symbol,
        name: (body['name'] as string).trim(),
        tickSize: body['tickSize'] as number,
        contractSize: body['contractSize'] as number,
        currency: (body['currency'] as string).trim(),
        expiryDate: new Date(body['expiryDate'] as string),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) {
        return reply.status(409).send({ error: 'Instrument already exists', symbol });
      }
      throw err;
    }

    const instrument = registry.get(symbol)!;
    return reply.status(201).send(instrument);
  });

  // ── DELETE /instruments/:symbol ────────────────────────────────────────────

  app.delete('/instruments/:symbol', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    if (!registry.get(symbol)) {
      return reply.status(404).send({ error: 'Instrument not found', symbol });
    }
    scheduler?.cancelSchedule(symbol);
    registry.delist(symbol);
    return reply.status(204).send();
  });

  // ── GET /instruments ───────────────────────────────────────────────────────

  app.get('/instruments', async (_request, reply) => {
    const instruments = registry.list().map((i) => ({
      symbol: i.symbol,
      name: i.name,
      tickSize: i.tickSize,
      contractSize: i.contractSize,
      currency: i.currency,
      expiryDate: i.expiryDate,
      marketState: i.marketState,
    }));
    return reply.status(200).send(instruments);
  });

  // ── Market State transitions ───────────────────────────────────────────────

  const TRANSITION_STATES: Record<string, MarketState> = {
    open: 'Open',
    close: 'Closed',
    halt: 'Halted',
    resume: 'Open',
  };

  for (const [action, targetState] of Object.entries(TRANSITION_STATES)) {
    app.post(`/instruments/:symbol/${action}`, async (request, reply) => {
      const { symbol } = request.params as { symbol: string };
      const instrument = registry.get(symbol);
      if (!instrument) {
        return reply.status(404).send({ error: 'Instrument not found', symbol });
      }
      const currentState = instrument.marketState;
      try {
        registry.setMarketState(symbol, targetState);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes('Invalid Market State transition')) {
          return reply.status(409).send({
            error: 'Invalid state transition',
            currentState,
            requestedState: targetState,
          });
        }
        throw err;
      }
      return reply.status(200).send({ symbol, marketState: targetState });
    });
  }

  // ── POST /instruments/:symbol/schedule ─────────────────────────────────────

  app.post('/instruments/:symbol/schedule', async (request, reply) => {
    const { symbol } = request.params as { symbol: string };
    if (!registry.get(symbol)) {
      return reply.status(404).send({ error: 'Instrument not found', symbol });
    }
    const body = request.body as Record<string, unknown>;
    const errors: string[] = [];
    const timePattern = /^\d{2}:\d{2}$/;
    if (typeof body['openTime'] !== 'string' || !timePattern.test(body['openTime'])) {
      errors.push('openTime must be a string in HH:MM format');
    }
    if (typeof body['closeTime'] !== 'string' || !timePattern.test(body['closeTime'])) {
      errors.push('closeTime must be a string in HH:MM format');
    }
    if (errors.length > 0) {
      return reply.status(422).send({ error: 'Validation failed', details: errors });
    }
    const entry = {
      openTime:  body['openTime']  as string,
      closeTime: body['closeTime'] as string,
    };
    schedules.set(symbol, entry);
    scheduler?.setSchedule(symbol, entry.openTime, entry.closeTime);
    return reply.status(200).send({ symbol, schedule: entry });
  });

  // ── Session management (requires gateway) ─────────────────────────────────

  if (gateway) {
    // POST /sessions ──────────────────────────────────────────────────────────

    app.post('/sessions', async (request, reply) => {
      const body = request.body as Record<string, unknown>;
      const errors: string[] = [];

      if (typeof body['senderCompId'] !== 'string' || (body['senderCompId'] as string).trim() === '') {
        errors.push('senderCompId is required and must be a non-empty string');
      }
      if (typeof body['targetCompId'] !== 'string' || (body['targetCompId'] as string).trim() === '') {
        errors.push('targetCompId is required and must be a non-empty string');
      }
      if (typeof body['port'] !== 'number' || !Number.isInteger(body['port']) || (body['port'] as number) <= 0) {
        errors.push('port is required and must be a positive integer');
      }

      if (errors.length > 0) {
        return reply.status(422).send({ error: 'Validation failed', details: errors });
      }

      const req = {
        senderCompId: (body['senderCompId'] as string).trim(),
        targetCompId: (body['targetCompId'] as string).trim(),
        port: body['port'] as number,
        host: typeof body['host'] === 'string' ? body['host'] : undefined,
        beginString: (body['beginString'] as 'FIX.4.2' | 'FIX.4.4' | undefined) ?? 'FIX.4.4',
        heartbeatIntervalSecs: typeof body['heartbeatIntervalSecs'] === 'number'
          ? (body['heartbeatIntervalSecs'] as number)
          : 30,
        mode: (body['mode'] as 'client' | 'server' | undefined) ?? 'server',
      };

      // Duplicate detection: derive the session ID and check if it already exists.
      const candidateId = `${req.senderCompId}-${req.targetCompId}-${req.beginString}`;
      if (gateway.hasSession(candidateId)) {
        return reply.status(409).send({ error: 'Session already exists', sessionId: candidateId });
      }

      const sessionId = gateway.addSession(req);
      const sessions = gateway.getSessions();
      const info = sessions.find((s) => s.sessionId === sessionId) ?? { sessionId, status: 'inactive' as const };
      return reply.status(201).send(info);
    });

    // DELETE /sessions/:sessionId ─────────────────────────────────────────────

    app.delete('/sessions/:sessionId', async (request, reply) => {
      const { sessionId } = request.params as { sessionId: string };
      if (!gateway.hasSession(sessionId)) {
        return reply.status(404).send({ error: 'Session not found', sessionId });
      }
      await gateway.removeSession(sessionId);
      return reply.status(204).send();
    });

    // GET /sessions ───────────────────────────────────────────────────────────

    app.get('/sessions', async (_request, reply) => {
      return reply.status(200).send(gateway.getSessions());
    });
  }

  return app;
}
