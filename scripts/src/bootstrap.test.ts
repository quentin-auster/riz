import assert from "node:assert/strict";
import { resolve } from "node:path";
import { test } from "node:test";
import { OpenFgaClient } from "@openfga/sdk";
import { bootstrapAdmin } from "./bootstrap.js";

test("refuses an admin subject that could name another OpenFGA user", async () => {
  // Rejected before any request, so the unreachable URL is never contacted.
  for (const admin of ["", "a#b", "user:x", "a b", "a|b"]) {
    await assert.rejects(
      bootstrapAdmin("unused.fga", { apiUrl: "http://127.0.0.1:1", admin }),
      /plain subject/,
    );
  }
});

// Integration: needs a running OpenFGA with no riz-admin store. Unverified until run against one.
test(
  "bootstraps once and refuses a second run, even past the first page of stores",
  { skip: process.env.OPENFGA_API_URL ? false : "OPENFGA_API_URL not set" },
  async () => {
    const apiUrl = process.env.OPENFGA_API_URL as string;
    const model = resolve(
      import.meta.dirname,
      "../../models/openfga/riz-admin.fga",
    );
    const client = new OpenFgaClient({ apiUrl });
    // Push the admin store beyond the first page so a one-page lookup would miss it.
    const filler: string[] = [];
    let storeId: string | undefined;
    try {
      for (let i = 0; i < 101; i++) {
        filler.push((await client.createStore({ name: "filler" })).id);
      }
      ({ storeId } = await bootstrapAdmin(model, { apiUrl, admin: "olga" }));
      await assert.rejects(
        bootstrapAdmin(model, { apiUrl, admin: "olga" }),
        /already exists/,
      );
    } finally {
      for (const id of [...filler, ...(storeId ? [storeId] : [])]) {
        await new OpenFgaClient({ apiUrl, storeId: id }).deleteStore();
      }
    }
  },
);
