import { type ChildProcess, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenFgaClient } from "@openfga/sdk";
import { transformer } from "@openfga/syntax-transformer";

// Black-box harness for the security suite: it starts the real API process (apps/api/src/index.ts)
// against the Postgres and OpenFGA in RIZ_DATABASE_URL and OPENFGA_API_URL, so what is tested is
// the production wiring, not a hand-built app. Fixture tokens are fixed test literals that live
// only in mode-0600 temp files; they are never the dev values in deploy/fixtures.

export function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const API_DIR = join(import.meta.dirname, "../../apps/api");

export type Fault = "pass" | "drop" | "hang";

/**
 * A TCP proxy in front of a dependency that can sever it (`drop`: connections are accepted and
 * closed at once) or blackhole it (`hang`: accepted and never answered). Switching mode also
 * cuts every open connection, so a pooled keep-alive connection cannot dodge the fault.
 */
export async function faultProxy(target: { host: string; port: number }) {
  let mode: Fault = "pass";
  const sockets = new Set<Socket>();
  const track = (s: Socket) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    s.on("error", () => {});
    return s;
  };
  const server = createServer((client) => {
    track(client);
    if (mode === "drop") return void client.destroy();
    if (mode === "hang") return;
    const upstream = track(connect(target));
    client.pipe(upstream);
    upstream.pipe(client);
    // Either side closing ends the pair, or a half-open socket would outlive the test.
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (typeof address !== "object" || address === null) {
    throw new Error("proxy has no port");
  }
  return {
    port: address.port,
    set(next: Fault) {
      mode = next;
      for (const s of sockets) s.destroy();
    },
    close() {
      for (const s of sockets) s.destroy();
      server.close();
    },
  };
}

export type FaultProxy = Awaited<ReturnType<typeof faultProxy>>;

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
  const address = probe.address();
  await new Promise((r) => probe.close(r));
  if (typeof address !== "object" || address === null) {
    throw new Error("no free port");
  }
  return address.port;
}

function spawnApi(env: Record<string, string>, port: number) {
  const output: string[] = [];
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts"], {
    cwd: API_DIR,
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => output.push(chunk.toString()));
  }
  return { child, output };
}

function stopper(child: ChildProcess) {
  return () =>
    new Promise<void>((resolve) => {
      if (child.exitCode !== null) return resolve();
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
}

export interface RunningApi {
  url: string;
  /** Everything the process wrote to stdout and stderr so far. */
  output: () => string;
  stop: () => Promise<void>;
}

/** Starts the API and resolves once it is listening. */
export async function startApi(
  env: Record<string, string>,
): Promise<RunningApi> {
  const port = await freePort();
  const { child, output } = spawnApi(env, port);
  const stop = stopper(child);
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (!output.join("").includes("riz api listening")) {
    if (child.exitCode !== null) {
      throw new Error(`API exited early: ${output.join("").slice(-500)}`);
    }
    if (Date.now() > deadline) {
      await stop();
      throw new Error("API did not start in time");
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { url, output: () => output.join(""), stop };
}

/** Starts the API expecting it to refuse to run; resolves with its exit code and output. */
export async function startApiExpectingExit(
  env: Record<string, string>,
): Promise<{ code: number | null; listening: boolean; output: string }> {
  const { child, output } = spawnApi(env, await freePort());
  const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
  const code = await new Promise<number | null>((r) =>
    child.once("exit", (c) => r(c)),
  );
  clearTimeout(timer);
  const text = output.join("");
  return { code, listening: text.includes("riz api listening"), output: text };
}

/** Points a dependency URL at a local fault proxy. */
export async function proxied(url: string, defaultPort: number) {
  const parsed = new URL(url);
  const proxy = await faultProxy({
    host: parsed.hostname,
    port: Number(parsed.port || defaultPort),
  });
  parsed.hostname = "127.0.0.1";
  parsed.port = String(proxy.port);
  return { proxy, url: parsed.toString().replace(/\/$/, "") };
}

export interface FixturePrincipal {
  subject: string;
  scopes: string[];
  applications: string[];
}

/** Writes fixture token files to a private temp directory. */
export function fixtureFiles(
  tokens: Record<string, FixturePrincipal>,
  endUsers: Record<string, string>,
) {
  const dir = mkdtempSync(join(tmpdir(), "riz-security-"));
  const auth = join(dir, "auth.json");
  const users = join(dir, "end-users.json");
  writeFileSync(auth, JSON.stringify(tokens), { mode: 0o600 });
  writeFileSync(users, JSON.stringify(endUsers), { mode: 0o600 });
  return {
    env: {
      NODE_ENV: "development",
      RIZ_AUTH_MODE: "fixture",
      RIZ_FIXTURE_AUTH_FILE: auth,
      RIZ_FIXTURE_END_USERS_FILE: users,
    },
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export const unique = (prefix: string) =>
  `${prefix}${randomBytes(5).toString("hex")}`;

export type Json = Record<string, unknown>;

export function client(base: string) {
  return async function call(
    method: string,
    path: string,
    opts: {
      token?: string;
      user?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ): Promise<{ status: number; body: Json }> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}),
        ...(opts.user ? { "riz-end-user-token": opts.user } : {}),
        "content-type": "application/json",
        ...opts.headers,
      },
      ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      // A regression that never times out a dependency must fail the test, not hang CI.
      signal: AbortSignal.timeout(30_000),
    });
    return {
      status: res.status,
      body: (await res.json().catch(() => ({}))) as Json,
    };
  };
}

export type Call = ReturnType<typeof client>;

/** The base model's read path: project:p1 gives alice read on document:d1. */
export const ALICE_READS = [
  { subject: "project:p1", relation: "project", object: "document:d1" },
  { subject: "user:alice", relation: "viewer", object: "project:p1" },
];

export const readDoc = (application: string, extra: object = {}) => ({
  application,
  relation: "read",
  object: "document:d1",
  ...extra,
});

/**
 * A riz-admin store at the repo's admin model holding `grants`, as the env the API needs in oidc mode.
 * A workload is named by the SHA-256 of `<issuer>|<workload>`, computed here independently of the API.
 */
export async function adminStore(
  grants: { issuer: string; workload: string; relation: string }[] = [],
) {
  const apiUrl = required("OPENFGA_API_URL");
  const { id: storeId } = await new OpenFgaClient({ apiUrl }).createStore({
    name: "riz-admin-security-test",
  });
  const { authorization_model_id: modelId } = await new OpenFgaClient({
    apiUrl,
    storeId,
  }).writeAuthorizationModel(
    transformer.transformDSLToJSONObject(
      readFileSync(
        join(import.meta.dirname, "../../models/openfga/riz-admin.fga"),
        "utf8",
      ),
    ),
  );
  if (!modelId) throw new Error("OpenFGA did not return a model id");
  if (grants.length > 0) {
    await new OpenFgaClient({
      apiUrl,
      storeId,
      authorizationModelId: modelId,
    }).write({
      writes: grants.map((g) => ({
        user: `user:${createHash("sha256").update(`${g.issuer}|${g.workload}`).digest("hex")}`,
        relation: g.relation,
        object: "organization:default",
      })),
    });
  }
  return { RIZ_ADMIN_STORE_ID: storeId, RIZ_ADMIN_MODEL_ID: modelId };
}
