import type { Message, SessionConfig, SessionStatus } from '@fixenginelib/core';

// ─── Interfaces ───────────────────────────────────────────────────────────────
// Thin abstractions over the fixserver Engine and Session. The real Engine and
// Session satisfy these structurally; tests inject mock implementations.

/** Minimal view of a FIX message used by the Gateway. The real Message class satisfies this. */
export interface IMessage {
  readonly sessionId: string;
  get(tag: number): string | undefined;
}

export interface IFixSession {
  readonly id: string;
  on(event: 'status', listener: (status: SessionStatus) => void): this;
  off(event: 'status', listener: (status: SessionStatus) => void): this;
}

export interface IFixEngine {
  start(): void;
  stop(): Promise<void>;
  messages(): AsyncIterable<IMessage>;
  addSession(config: SessionConfig): IFixSession;
  removeSession(sessionId: string): Promise<void>;
  getSessions(): IFixSession[];
  getSession(sessionId: string): IFixSession | undefined;
  sendMessage(sessionId: string, fields: Map<number, string>): void;
}

export type { SessionConfig, SessionStatus, Message, IMessage };
