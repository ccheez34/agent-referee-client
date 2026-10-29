// Multi-part judge receipts (judge-multi-v1, tiers judge-3x2 and judge-3x3), checked against the server's own test
// vectors: test/fixtures/multi-judge-vectors.json, copied from agent-referee-server (scripts/gen-multi-judge-vectors.mjs).
// Each case runs the checks an agent would use: the receipt's and every ack's signature, then verifyOutcome with the
// pieces each side holds and the acks. The Python client's tests run the same vectors.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentReferee, Seat, canonicalJson, sha256Hex, verifyOutcome, verifySignature } from "../src/index.mjs";

const vx = JSON.parse(readFileSync(new URL("./fixtures/multi-judge-vectors.json", import.meta.url), "utf8"));
const keys = [vx.public_key];
const byId = (id) => vx.cases.find((c) => c.id === id);
async function check(c, opts = { pieces: c.given.pieces, acks: c.given.acks }) {
  let signed = await verifySignature(c.receipt, keys);
  for (const a of opts.acks ?? []) signed = signed && (await verifySignature(a, keys));
  const r = await verifyOutcome(c.receipt, opts);
  return { ok: signed && r.ok, signed, problems: r.problems, r };
}

test("building blocks: side piece records, canonical JSON and pieces_sha256 match the server's", async () => {
  assert.ok(vx.building_blocks.length > 0);
  for (const b of vx.building_blocks) {
    const texts = b.texts ?? b.pieces;
    const recs = await Promise.all(texts.map(async (t, i) => ({ index: i + 1, sha256: await sha256Hex(typeof t === "string" ? t : t.text), chars: (typeof t === "string" ? t : t.text).length })));
    assert.deepEqual(recs, b.records);
    assert.equal(canonicalJson(recs), b.canonical);
    assert.equal(await sha256Hex(b.canonical), b.pieces_sha256);
  }
});

test("every server test vector gives the expected result", async () => {
  assert.equal(vx.cases.length, 20);
  for (const c of vx.cases) {
    const r = await check(c);
    assert.equal(r.ok, c.expect.ok, `${c.id}: ${JSON.stringify(r.problems)}`);
    if (c.expect.ok) {
      assert.deepEqual(r.problems, [], c.id);
      assert.equal(c.receipt.payload.outcome.winner, c.expect.winner, c.id);
      if (c.expect.by_forfeit) assert.equal(c.receipt.payload.outcome.by_forfeit, true);
    } else if (c.id === "bad-signature") assert.equal(r.signed, false);
    else assert.ok(r.problems.length > 0, `${c.id} should name a problem`);
  }
});

test("each failing vector fails for its own reason", async () => {
  const want = {
    "wrong-piece-text": /alpha's piece 2 is different/,
    "pieces-swapped": /alpha's pieces, but in a different order/,
    "wrong-count": /alpha has 2 pieces on judge-3x2; you passed 3/,
    "bad-pieces-sha256": /beta's pieces_sha256 doesn't match/,
    "chars-as-code-points": /alpha's piece 1 length/,
    "missing-side": /must have both sides' pieces/,
    "has-submission-sha256": /never has proof\.submission_sha256/,
    "bad-winner": /decision should be/,
    "bad-tally": /tally doesn't match/,
    "two-votes": /Expected 3 votes/,
    "same-company": /three different AI companies/,
    "wrong-format-version": /agent-referee-judge-v5-multi/,
    "unknown-format": /can't check, so nothing was confirmed\. Update the client/,
    "old-tier-name": /must be for a multi-part judge tier/,
    "ack-pieces-changed": /alpha's submission was changed/,
    "forfeit-after-ack": /beta is listed as forfeiting after the service accepted its submission/,
  };
  for (const [id, re] of Object.entries(want)) {
    const r = await check(byId(id));
    assert.ok(r.problems.some((m) => re.test(m)), `${id}: ${JSON.stringify(r.problems)}`);
  }
});

test("without the pieces it checks what the receipt alone can show; a seat checks its own pieces", async () => {
  const c = byId("valid-3x2");
  assert.equal((await verifyOutcome(c.receipt)).ok, true);
  const ref = new AgentReferee({ url: "https://agentreferee.ai", publicKeys: keys });
  const seat = new Seat(ref, c.receipt.payload.match_id, "alpha", "tok", "judge-3x2");
  seat.pieces = c.given.pieces.alpha;
  assert.equal((await verifyOutcome(c.receipt, { seat })).ok, true);
  seat.pieces = [...c.given.pieces.alpha].reverse();
  const r = await verifyOutcome(c.receipt, { seat });
  assert.ok(r.problems.includes("These are alpha's pieces, but in a different order."), JSON.stringify(r.problems));
  const none = await verifyOutcome(c.receipt, { pieces: { gamma: ["x", "y"] } });
  assert.ok(none.problems.includes("The receipt has no pieces for gamma."));
});

test("submit(): multi-part judge tiers send pieces of text, refuse a wrong shape before sending", async () => {
  const sent = [];
  const fakeFetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const ref = new AgentReferee({ url: "https://agentreferee.ai", fetch: fakeFetch, publicKeys: keys });
  const seat = new Seat(ref, "m1", "alpha", "tok", "judge-3x2");
  seat.client.waitFor = async () => ({ phase: "done" }); // no polling in this test
  await seat.submit(["Plan A: $40 in all.\n", { text: "Ships in 2 days." }]);
  assert.deepEqual(sent[0].body, { seat: "alpha", seat_token: "tok", pieces: [{ text: "Plan A: $40 in all.\n" }, { text: "Ships in 2 days." }] });
  assert.deepEqual(seat.pieces, ["Plan A: $40 in all.\n", "Ships in 2 days."]);
  for (const bad of ["one string", ["only one"], ["a", "b", "c"], ["a", "   "], [{ name: "x" }, "b"]]) await assert.rejects(seat.submit(bad), /Nothing was sent/);
  const single = new Seat(ref, "m2", "alpha", "tok", "judge-3");
  await assert.rejects(single.submit(["a", "b"]), /one position/);
  assert.equal(sent.length, 1);
});

test("forfeits: the side that submitted must win, and only the other side may be listed as forfeiting", async () => {
  const c = byId("valid-forfeit");
  const p = c.receipt.payload;
  const msg = "In a forfeit, the side that submitted must be the winner, and only the other side may be listed as forfeiting.";
  for (const outcome of [
    { ...p.outcome, winner: "beta" }, // the side that forfeited wins
    { ...p.outcome, winner: null },
    { ...p.outcome, winner: "mallory" },
    { ...p.outcome, forfeited: ["alpha", "beta"] },
  ]) {
    const r = await verifyOutcome({ ...p, outcome }, { pieces: c.given.pieces });
    assert.equal(r.ok, false, JSON.stringify(outcome));
    assert.ok(r.problems.includes(msg), JSON.stringify(r.problems));
  }
  const none = await verifyOutcome({ ...p, outcome: { ...p.outcome, forfeited: ["alpha", "beta"] }, proof: { ...p.proof, pieces: {}, pieces_sha256: {} } });
  assert.ok(none.problems.includes(msg));
  assert.equal((await verifyOutcome({ ...p, outcome: { ...p.outcome, forfeited: "beta" } })).ok, false); // no crash
});

test("a seat's own pieces are checked even when other pieces are passed; records must be exactly {index, sha256, chars}", async () => {
  const c = byId("wrong-piece-text");
  const ref = new AgentReferee({ url: "https://agentreferee.ai", publicKeys: keys });
  const seat = new Seat(ref, c.receipt.payload.match_id, "alpha", "tok", "judge-3x2");
  seat.pieces = c.given.pieces.alpha;
  for (const pieces of [undefined, {}, { beta: c.given.pieces.beta }]) {
    const r = await verifyOutcome(c.receipt, { seat, ...(pieces ? { pieces } : {}) });
    assert.ok(r.problems.includes("alpha's piece 2 is different from the one in the receipt."), JSON.stringify(r.problems));
  }
  const v = structuredClone(byId("valid-3x2").receipt.payload);
  v.proof.pieces.alpha[0].name = "alice";
  v.proof.pieces_sha256.alpha = await sha256Hex(canonicalJson(v.proof.pieces.alpha));
  assert.ok((await verifyOutcome(v)).problems.includes("alpha's piece 1 record in the receipt is malformed."));
  assert.ok((await verifyOutcome(byId("valid-3x2").receipt, { pieces: [["a", "b"]] })).problems.includes('pieces must be by seat: { "seat": ["text 1", "text 2"] }.'));
});
