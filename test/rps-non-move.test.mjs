// A reveal that isn't rock, paper or scissors ("lizard", "Rock", "toString"): the seat is named and the round isn't
// scored. Before this, such a round went to the second party (RPS_BEATS[va] === vb ? a : b), so a receipt where y won
// with "lizard" checked clean. The service refuses non-moves at reveal, so only a fault in the service could sign one
// (2.0's 0847, Nov 11). The cases are shared with the Python client, which gives the same answers.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { verifyOutcome } from "../src/index.mjs";

const C = JSON.parse(readFileSync(new URL("./fixtures/rps-non-move-cases.json", import.meta.url), "utf8"));
const commit = (s) => createHash("sha256").update(s).digest("hex");
const fill = (x) =>
  typeof x === "string" && x.startsWith("@commit:") ? commit(x.slice(8))
  : Array.isArray(x) ? x.map(fill)
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fill(v)]))
  : x;

test("rps non-moves: every case gives the shared answer", async () => {
  assert.equal(C.cases.length, 4);
  for (const c of C.cases) assert.deepEqual((await verifyOutcome(fill(c.payload))).problems, c.expect, c.name);
});
