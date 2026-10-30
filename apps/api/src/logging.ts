export type Log = (entry: Record<string, unknown>) => void;

const SENSITIVE_KEY = /authorization|token|secret|password|cookie|api[-_]?key/i;
const BEARER = /\bBearer\s+\S+/gi;

/** Masks sensitive keys and any `Bearer <credential>` text, at any depth. */
export function redact(value: unknown): unknown {
  if (typeof value === "string")
    return value.replace(BEARER, "Bearer [redacted]");
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        SENSITIVE_KEY.test(k) ? "[redacted]" : redact(v),
      ]),
    );
  }
  return value;
}

/** One JSON object per line on stdout. Every entry passes through `redact`. */
export const stdoutLog: Log = (entry) => {
  console.log(JSON.stringify(redact(entry)));
};
