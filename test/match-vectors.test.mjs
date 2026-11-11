// Cross-language match vectors: test/fixtures/match-vectors.json is agent-referee-python's tests/vectors.json
// (sha256 b0e0b8b099f8…, copied Nov 11, 2026). Its receipts were made by the server's own code, signed by a throwaway
// key, and its expected answers by this client at 0.8.0 (agent-referee-python's tests/js/gen_vectors.mjs). The Python
// client must give exactly these answers; this test holds the JS client to them too, for every match tier
// (weighted, draw, rps, rps-bo3 and the judge tiers), with and without the seat.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findContradictions, verifyOutcome, verifySignature } from "../src/index.mjs";

const V = JSON.parse(readFileSync(new URL("./fixtures/match-vectors.json", import.meta.url), "utf8"));

function same(got, want, label) {
  assert.equal(got.ok, want.ok, `${label}: ok`);
  assert.deepEqual(got.problems, want.problems, `${label}: problems`);
  assert.deepEqual(got.trusts, want.trusts, `${label}: trusts`);
  if ("recomputed" in want) assert.equal(got.recomputed, want.recomputed, `${label}: recomputed`);
  if ("evidence" in want) assert.deepEqual((got.evidence ?? []).map((e) => e.reason), want.evidence.map((e) => e.reason), `${label}: evidence`);
}

test("every match vector gives the same answer as before, with and without the seat", async () => {
  assert.equal(V.matches.length, 51);
  for (const c of V.matches) {
    assert.equal(await verifySignature(c.receipt, [V.public_key]), c.signed, `${c.name}: signed`);
    same(await verifyOutcome(c.receipt), c.without_seat, `${c.name} (no seat)`);
    if (c.seat) {
      same(await verifyOutcome(c.receipt, { seat: c.seat }), c.with_seat, `${c.name} (seat)`);
      assert.deepEqual(findContradictions(c.receipt, c.seat.acks).map((e) => e.reason), c.contradictions, `${c.name}: contradictions`);
    }
  }
});
