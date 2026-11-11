// Seat names an object inherits ("toString", "constructor"): the random tiers' checks and findContradictions read a
// seat's entry only from an own key, so a missing entry reads as missing, never as the inherited function. The cases
// and their expected answers are in fixtures/seat-name-cases.json; each answer is the Python client's, which reads
// only a dict's own keys. The service refuses such seat names since Nov 9, so no genuine receipt holds one.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { canonicalJson, findContradictions, sha256Hex, verifyOutcome, verifySeries } from "../src/index.mjs";

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

test("verifySeries: a series given from the middle counts a win for a party named toString or __proto__", async () => {
  // Found by 2.0 in its read of own-key-random-tiers (2.0's 0847): t.wins["toString"] read the inherited function, so
  // the tally held "function toString() { [native code] }1" and game 3's signed tally looked wrong; "__proto__" lost
  // the win. The Python client counts both as 1, as here.
  for (const name of ["toString", "__proto__", "alpha"]) {
    const parties = [name, "zed"];
    const g2 = { tier: "weighted", match_id: "s-g2", parties, outcome: { winner: "zed" },
      series: { series_id: "s-g1", game: 2, previous_match_id: "s-g1", previous_receipt_sha256: "0".repeat(64), tally: { games: 2, wins: { zed: 1 }, no_result: 1 } } };
    const g3 = { tier: "weighted", match_id: "s-g3", parties, outcome: { winner: name },
      series: { series_id: "s-g1", game: 3, previous_match_id: "s-g2", previous_receipt_sha256: await sha256Hex(canonicalJson(g2)), tally: JSON.parse(`{"games":3,"wins":{"zed":1,${JSON.stringify(name)}:1},"no_result":1}`) } };
    const r = await verifySeries(JSON.parse(JSON.stringify([g2, g3])));
    assert.deepEqual(r.problems, [], name);
    assert.equal(canonicalJson(r.tally), canonicalJson(JSON.parse(`{"games":3,"wins":{"zed":1,${JSON.stringify(name)}:1},"no_result":1}`)), name);
  }
});
