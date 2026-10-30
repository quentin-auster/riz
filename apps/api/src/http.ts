import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** Reuses a well-formed caller-supplied ID, otherwise mints one. */
export function newRequestId(supplied: string | undefined): string {
  return supplied && REQUEST_ID.test(supplied)
    ? supplied
    : `req_${randomUUID()}`;
}

/** The ID `createApp` assigned to this request; also sent as `X-Request-Id`. */
export function requestIdOf(res: ServerResponse): string {
  return String(res.getHeader("x-request-id"));
}

export function sendError(res: ServerResponse, err: HttpError) {
  send(res, err.status, {
    code: err.code,
    message: err.message,
    requestId: requestIdOf(res),
  });
}

/** Reads a JSON body, rejecting anything over `maxBytes` before parsing it. */
export async function readJson(
  req: IncomingMessage,
  maxBytes = 1_000_000,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      throw new HttpError(400, "invalid_request", "Request body too large.");
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "invalid_request", "Body must be valid JSON.");
  }
}
