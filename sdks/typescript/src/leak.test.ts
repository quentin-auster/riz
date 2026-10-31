import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";
import { Riz, RizTransportError } from "./index.js";

test("a transport error does not carry the end-user token, even in its cause chain", async () => {
  const riz = new Riz({
    baseUrl: "http://127.0.0.1:9",
    credentials: "svc-token",
    application: "crm",
  });
  // A newline is an invalid header value, which fetch rejects while quoting it.
  const err = await riz
    .check({
      action: "read",
      resource: "document:d1",
      endUserToken: "SECRET\nX",
    })
    .catch((e: unknown) => e);

  assert.ok(err instanceof RizTransportError);
  assert.ok(!inspect(err, { depth: 10 }).includes("SECRET"));
});
