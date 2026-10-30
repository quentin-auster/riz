import type pg from "pg";

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timeout")), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Probes PostgreSQL and OpenFGA, each bounded by `timeoutMs`. Resolves to the
 * names of the dependencies that are down; empty means ready.
 */
export function readiness(deps: {
  pool: pg.Pool;
  openfgaUrl: string;
  timeoutMs: number;
}): () => Promise<string[]> {
  const { pool, openfgaUrl, timeoutMs } = deps;
  const probes: Record<string, () => Promise<unknown>> = {
    postgres: () => withTimeout(pool.query("SELECT 1"), timeoutMs),
    openfga: async () => {
      const res = await fetch(`${openfgaUrl}/healthz`, {
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`status ${res.status}`);
    },
  };
  return async () => {
    const down: string[] = [];
    await Promise.all(
      Object.entries(probes).map(([name, probe]) =>
        probe().catch(() => {
          down.push(name);
        }),
      ),
    );
    return down.sort();
  };
}
