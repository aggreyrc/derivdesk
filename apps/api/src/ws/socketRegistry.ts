import type { WebSocket } from "ws";

// Tracks live browser sockets by session and user so that (a) logging out closes that browser's
// stream immediately, and (b) one user cannot hold an unbounded number of connections.
// Kept free of any other app import so auth.controller can depend on it without pulling in the
// market/trading gateways.

export const MAX_SOCKETS_PER_USER = 5;
export const CLOSE_SESSION_ENDED = 4401; // application-defined: the session is no longer valid

interface Entry {
  userId: string;
  sessionId: string;
  ws: Pick<WebSocket, "close">;
}

const entries = new Set<Entry>();

export function countSocketsForUser(userId: string): number {
  let n = 0;
  for (const e of entries) if (e.userId === userId) n++;
  return n;
}

export function countAllSockets(): number {
  return entries.size;
}

/** Returns an unregister function. */
export function registerSocket(userId: string, sessionId: string, ws: Pick<WebSocket, "close">): () => void {
  const entry: Entry = { userId, sessionId, ws };
  entries.add(entry);
  return () => entries.delete(entry);
}

export function closeSocketsForSession(sessionId: string): void {
  for (const e of [...entries]) {
    if (e.sessionId === sessionId) {
      e.ws.close(CLOSE_SESSION_ENDED, "session ended");
      entries.delete(e);
    }
  }
}

export function _resetSocketRegistryForTests(): void {
  entries.clear();
}
