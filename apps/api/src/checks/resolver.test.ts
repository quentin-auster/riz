import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ApplicationNotFound,
  createResolver,
  type Lookup,
  NoActiveModel,
} from "./resolver.js";

const API = "http://openfga.invalid";

test("builds a client pinned to the application's store and model", async () => {
  const storeId = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
  const modelId = "01BX5ZZKBKACTAV9WEVGEMMVRY";
  const lookup: Lookup = async () => ({ storeId, modelId });
  const client = await createResolver(lookup, API).clientFor("crm-prod");
  assert.equal(client.storeId, storeId);
  assert.equal(client.authorizationModelId, modelId);
});

test("never yields a client for an application without a model ID", async () => {
  const lookup: Lookup = async () => ({ storeId: "s1", modelId: null });
  await assert.rejects(
    createResolver(lookup, API).clientFor("crm-prod"),
    NoActiveModel,
  );
});

test("rejects an unknown application instead of falling back to a store", async () => {
  const lookup: Lookup = async () => null;
  await assert.rejects(
    createResolver(lookup, API).clientFor("nope-prod"),
    ApplicationNotFound,
  );
});
