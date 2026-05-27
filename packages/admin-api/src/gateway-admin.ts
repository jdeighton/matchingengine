// ─── Session management interface ────────────────────────────────────────────
// Thin abstraction over the Gateway used by the Admin API.  The real Gateway
// satisfies this structurally; tests inject a mock implementation.

export interface SessionRequest {
  senderCompId: string;
  targetCompId: string;
  port: number;
  /** 'server' by default */
  mode?: 'client' | 'server';
  host?: string;
  /** 'FIX.4.4' by default */
  beginString?: 'FIX.4.2' | 'FIX.4.4';
  /** Seconds between heartbeat messages. 30 by default. */
  heartbeatIntervalSecs?: number;
}

export interface SessionInfo {
  sessionId: string;
  /** 'active' when the FIX Logon has been completed; 'inactive' otherwise. */
  status: 'active' | 'inactive';
}

export interface IGatewayAdmin {
  /** Add a FIX session at runtime. Returns the session ID assigned by the engine. */
  addSession(req: SessionRequest): string;
  /** Disconnect and remove a FIX session by its ID. */
  removeSession(sessionId: string): Promise<void>;
  /** List all configured sessions with their current connection status. */
  getSessions(): SessionInfo[];
  /** Returns true if a session with the given ID is currently configured. */
  hasSession(sessionId: string): boolean;
}
