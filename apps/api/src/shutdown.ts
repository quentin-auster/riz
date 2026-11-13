import type { Server } from "node:http";

/**
 * Stop accepting connections and let in-flight requests finish. Anything still open after
 * `timeoutMs` is cut, so a stuck request cannot block a rollout forever.
 */
export function drain(server: Server, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const cut = setTimeout(() => server.closeAllConnections(), timeoutMs);
    // A keep-alive connection that is busy now goes idle later; close it then, or close()
    // waits for the client to hang up.
    const idle = setInterval(() => server.closeIdleConnections(), 50);
    server.close(() => {
      clearTimeout(cut);
      clearInterval(idle);
      resolve();
    });
  });
}
