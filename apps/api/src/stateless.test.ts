import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Replicas share nothing but Postgres and OpenFGA (docs/decisions/0009-multi-replica.md), so
// the API may read files it ships with but never write, or any replica's state would differ.
const READ_ONLY = new Set(["readFileSync", "readdirSync"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return path.endsWith(".ts") && !path.endsWith(".test.ts") ? [path] : [];
  });
}

test("the API source only ever reads from the filesystem", () => {
  for (const file of sources(import.meta.dirname)) {
    const code = readFileSync(file, "utf8");
    assert.ok(!/node:fs\/promises|from "fs"/.test(code), `${file} uses fs`);
    for (const [, names] of code.matchAll(
      /import \{([^}]*)\} from "node:fs"/g,
    )) {
      for (const name of (names ?? "").split(",").map((n) => n.trim())) {
        assert.ok(READ_ONLY.has(name), `${file} imports ${name} from node:fs`);
      }
    }
  }
});
