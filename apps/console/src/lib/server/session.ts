import { randomBytes } from "node:crypto";

export interface Session {
  subject: string;
  /** Held server-side only; forwarded to the riz API, never sent to the browser. */
  accessToken: string;
  expiresAt: number;
}

/**
 * The cookie carries only an opaque random ID.
 * shortcut: in memory, so sessions are lost on restart and not shared between replicas;
 * move to a shared store before running more than one console replica.
 */
export function createSessionStore(now: () => number = Date.now) {
  const sessions = new Map<string, Session>();
  return {
    create(session: Session): string {
      const id = randomBytes(32).toString("base64url");
      sessions.set(id, session);
      return id;
    },
    get(id: string | undefined): Session | null {
      const session = id ? sessions.get(id) : undefined;
      if (!id || !session) return null;
      if (session.expiresAt <= now()) {
        sessions.delete(id);
        return null;
      }
      return session;
    },
    destroy(id: string | undefined): void {
      if (id) sessions.delete(id);
    },
  };
}

export type SessionStore = ReturnType<typeof createSessionStore>;
