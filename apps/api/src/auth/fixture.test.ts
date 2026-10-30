import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { authenticatorFromEnv, endUserVerifierFromEnv } from "./index.js";

const SECRET = "s3cret-token";

function fixtureFile(contents: string): string {
  const file = join(mkdtempSync(join(tmpdir(), "riz-auth-")), "auth.json");
  writeFileSync(file, contents);
  return file;
}

const valid = JSON.stringify({
  [SECRET]: { subject: "anne", scopes: ["check"], applications: ["crm-prod"] },
});

test("refuses to start with fixture auth in production", () => {
  assert.throws(
    () =>
      authenticatorFromEnv({
        NODE_ENV: "production",
        RIZ_AUTH_MODE: "fixture",
        RIZ_FIXTURE_AUTH_FILE: fixtureFile(valid),
      }),
    /must not be used in production/,
  );
});

test("refuses to start when no auth mode is configured", () => {
  assert.throws(() => authenticatorFromEnv({}), /RIZ_AUTH_MODE/);
});

test("resolves a fixture token to its principal and rejects others", () => {
  const authenticate = authenticatorFromEnv({
    RIZ_AUTH_MODE: "fixture",
    RIZ_FIXTURE_AUTH_FILE: fixtureFile(valid),
  });
  assert.equal(authenticate(`Bearer ${SECRET}`)?.subject, "anne");
  assert.equal(authenticate("Bearer other"), null);
  assert.equal(authenticate(undefined), null);
});

test("resolves a fixture end-user token to its subject and rejects others", () => {
  const verify = endUserVerifierFromEnv({
    RIZ_AUTH_MODE: "fixture",
    RIZ_FIXTURE_END_USERS_FILE: fixtureFile(`{"${SECRET}": "alice"}`),
  });
  assert.equal(verify(SECRET), "alice");
  assert.equal(verify("other"), null);
  assert.equal(verify(undefined), null);
});

test("a malformed fixture file is rejected without echoing its contents", () => {
  const env = {
    RIZ_AUTH_MODE: "fixture",
    RIZ_FIXTURE_AUTH_FILE: fixtureFile(`{"${SECRET}": oops`),
  };
  assert.throws(
    () => authenticatorFromEnv(env),
    (err: Error) =>
      /invalid fixture/.test(err.message) &&
      !err.message.includes(SECRET) &&
      err.cause === undefined,
  );
});
