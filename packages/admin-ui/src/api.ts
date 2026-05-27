// ─── Domain types ─────────────────────────────────────────────────────────────

export type MarketState = 'Closed' | 'Open' | 'Halted';
export type StateAction  = 'open' | 'close' | 'halt' | 'resume';

export interface Instrument {
  symbol:       string;
  name:         string;
  tickSize:     number;
  contractSize: number;
  currency:     string;
  expiryDate:   string;  // ISO date string (YYYY-MM-DD)
  marketState:  MarketState;
  openTime?:    string;
  closeTime?:   string;
}

export interface ApiError {
  error:    string;
  details?: string[];
}

// ─── Session types ────────────────────────────────────────────────────────────

/** Raw session data returned by GET /sessions and POST /sessions. */
export interface SessionInfo {
  sessionId: string;
  status:    'active' | 'inactive';
}

/** Session enriched with the metadata the client captured at add-time. */
export interface SessionDisplay extends SessionInfo {
  senderCompId: string;
  targetCompId: string;
  port:         number;
}

export interface AddSessionRequest {
  senderCompId:           string;
  targetCompId:           string;
  port:                   number;
  beginString?:           'FIX.4.2' | 'FIX.4.4';
  heartbeatIntervalSecs?: number;
}

// ─── Valid transitions ────────────────────────────────────────────────────────

export const VALID_ACTIONS: Record<MarketState, StateAction[]> = {
  Closed:  ['open'],
  Open:    ['close', 'halt'],
  Halted:  ['resume', 'close'],
};

// ─── API client ───────────────────────────────────────────────────────────────

async function handleResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText })) as ApiError;
    throw new Error(body.error ?? res.statusText);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export const api = {
  getInstruments(): Promise<Instrument[]> {
    return fetch('/instruments').then((r) => handleResponse<Instrument[]>(r));
  },

  addInstrument(body: Omit<Instrument, 'marketState'>): Promise<Instrument> {
    return fetch('/instruments', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    }).then((r) => handleResponse<Instrument>(r));
  },

  delistInstrument(symbol: string): Promise<void> {
    return fetch(`/instruments/${symbol}`, { method: 'DELETE' })
      .then((r) => handleResponse<void>(r));
  },

  setMarketState(symbol: string, action: StateAction): Promise<Instrument> {
    return fetch(`/instruments/${symbol}/${action}`, { method: 'POST' })
      .then((r) => handleResponse<Instrument>(r));
  },

  setSchedule(symbol: string, openTime: string, closeTime: string): Promise<unknown> {
    return fetch(`/instruments/${symbol}/schedule`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ openTime, closeTime }),
    }).then((r) => handleResponse<unknown>(r));
  },

  getSessions(): Promise<SessionInfo[]> {
    return fetch('/sessions').then((r) => handleResponse<SessionInfo[]>(r));
  },

  addSession(req: AddSessionRequest): Promise<SessionInfo> {
    return fetch('/sessions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(req),
    }).then((r) => handleResponse<SessionInfo>(r));
  },

  removeSession(sessionId: string): Promise<void> {
    return fetch(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' })
      .then((r) => handleResponse<void>(r));
  },
};
