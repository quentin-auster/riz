import assert from "node:assert/strict";
import { test } from "node:test";
import { RizClient } from "./index.js";

test("client keeps the configured base url", () => {
  assert.equal(new RizClient("http://riz.test").baseUrl, "http://riz.test");
});
