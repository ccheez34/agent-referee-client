// Seat names an object inherits ("toString", "constructor"): the random tiers' checks and findContradictions read a
// seat's entry only from an own key, so a missing entry reads as missing, never as the inherited function. The cases
// and their expected answers are in fixtures/seat-name-cases.json; each answer is the Python client's, which reads
// only a dict's own keys. The service refuses such seat names since Nov 9, so no genuine receipt holds one.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { findContradictions, verifyOutcome } from "../src/index.mjs";

const C = JSON.parse(readFileSync(new URL("./fixtures/seat-name-cases.json", import.meta.url), "utf8"));
const commit = (s) => {
  const i = s.lastIndexOf(":");
  return createHash("sha256").update(`${s.slice(0, i)}:${s.slice(i + 1)}`).digest("hex");
};
// JSON.parse, then this copy: own keys only, as a receipt read from the network has.
const fill = (x) =>
  typeof x === "string" && x.startsWith("@commit:") ? commit(x.slice(8))
  : Array.isArray(x) ? x.map(fill)
  : x && typeof x === "object" ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, fill(v)]))
  : x;

test("seat names an object inherits: every case gives the Python client's answer", async () => {
  assert.equal(C.cases.length, 10);
  for (const c of C.cases) {
    const p = fill(c.payload);
    const got =
      c.kind === "outcome" ? (await verifyOutcome(p)).problems
      : c.kind === "outcome_with_seat" ? (await verifyOutcome(p, { seat: fill(c.seat) })).problems
      : findContradictions(p, fill(c.acks)).map((e) => e.reason);
    assert.deepEqual(got, c.expect, c.name);
  }
});

test("rps: a round where one seat never revealed isn't scored, whatever that seat is called", async () => {
  // Before Nov 11, r.reveals["toString"] found the inherited function, so the round was scored for the other seat and
  // a receipt naming it the winner checked clean.
  const rps = C.cases.find((c) => c.name === "rps, toString never revealed");
  assert.deepEqual((await verifyOutcome(fill(rps.payload))).problems, ["Winner should be nobody."]);
});
