// Multi-part review receipts (review-multi-v1, tiers review-3x2 and review-3x3), checked against the server's own
// test vectors: test/fixtures/multi-review-vectors.json, copied from agent-referee-server (scripts/gen-multi-vectors.mjs).
// Every case is run through the same checks an agent would use: the signature, then verifyReviewOutcome with the
// task and pieces the verifier holds. The Python client's tests run the same vectors.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { AgentReferee, canonicalJson, sha256Hex, verifyReviewOutcome, verifySignature } from "../src/index.mjs";

const vx = JSON.parse(readFileSync(new URL("./fixtures/multi-review-vectors.json", import.meta.url), "utf8"));
const keys = [vx.public_key];
const check = async (c, opts = { task: c.given.task, pieces: c.given.pieces }) => {
  const signed = await verifySignature(c.receipt, keys);
  const r = await verifyReviewOutcome(c.receipt, opts);
  return { ok: signed && r.ok, signed, problems: r.problems };
};

test("building blocks: piece records, canonical JSON and pieces_sha256 match the server's", async () => {
  for (const b of vx.building_blocks) {
    const recs = await Promise.all(b.pieces.map(async (p, i) => ({ index: i + 1, name: p.name ?? "", sha256: await sha256Hex(p.text), chars: p.text.length })));
    assert.deepEqual(recs, b.records);
    assert.equal(canonicalJson(recs), b.canonical);
    assert.equal(await sha256Hex(b.canonical), b.pieces_sha256);
  }
});

test("every server test vector gives the expected result", async () => {
  assert.equal(vx.cases.length, 17);
  for (const c of vx.cases) {
    const r = await check(c);
    assert.equal(r.ok, c.expect.ok, `${c.id}: ${JSON.stringify(r.problems)}`);
    if (c.expect.ok) {
      assert.deepEqual(r.problems, []);
      assert.equal(c.receipt.payload.result.verdict, c.expect.verdict);
    } else if (c.id === "bad-signature") {
      assert.equal(r.signed, false);
    } else {
      assert.ok(r.problems.length > 0, `${c.id} should name a problem`);
    }
  }
});

test("each failing vector fails for its own reason", async () => {
  const want = {
    "wrong-piece-text": /Piece 2 is different/,
    "missing-name": /Piece 1's name differs/,
    "pieces-swapped": /in a different order/,
    "wrong-task": /different task/,
    "wrong-count": /This review has 2 pieces; you passed 3/,
    "bad-pieces-sha256": /pieces_sha256 doesn't match/,
    "chars-as-code-points": /Piece 1's length/,
    "bad-verdict": /the verdict should be/,
    "two-votes": /Expected 3 reviewer votes/,
    "same-company": /three different AI companies/,
    "no-issues-dropped": /issues_dropped/,
    "has-output-sha256": /never has output_sha256/,
    "unknown-format": /can't check, so nothing was confirmed\. Update the client/,
    "old-tier-name": /must be for a multi-part tier/,
  };
  for (const [id, re] of Object.entries(want)) {
    const c = vx.cases.find((x) => x.id === id);
    const r = await check(c);
    assert.ok(r.problems.some((m) => re.test(m)), `${id}: ${JSON.stringify(r.problems)}`);
  }
});

test("a valid receipt checked with output instead of pieces, or without pieces, says what was and wasn't checked", async () => {
  const c = vx.cases.find((x) => x.id === "valid-3x2");
  const withOutput = await verifyReviewOutcome(c.receipt, { task: c.given.task, output: "anything" });
  assert.equal(withOutput.ok, false);
  assert.ok(withOutput.problems.includes("This is a multi-part review: check it with pieces, not output."));
  const noPieces = await verifyReviewOutcome(c.receipt, { task: c.given.task }); // like a check without output: hashes only
  assert.equal(noPieces.ok, true);
  const tierMismatch = await verifyReviewOutcome(c.receipt, { task: c.given.task, pieces: c.given.pieces, tier: "review-3x3" });
  assert.ok(tierMismatch.problems.includes("This review is review-3x2, not review-3x3."));
});

test("a multi-part tier without receipt_format, and pieces on a single-piece review, are refused", async () => {
  const c = vx.cases.find((x) => x.id === "valid-3x2");
  const { receipt_format, ...noFormat } = c.receipt.payload;
  const r = await verifyReviewOutcome(noFormat, { task: c.given.task, pieces: c.given.pieces });
  assert.deepEqual(r.problems, ["A review-3x2 receipt must say receipt_format review-multi-v1; this one doesn't, so it can't be checked."]);
  const fx = JSON.parse(readFileSync(new URL("./fixtures/receipts.json", import.meta.url), "utf8"));
  const s = await verifyReviewOutcome(fx.review_3, { task: fx.review_3_task, pieces: [{ text: fx.review_3_output }] });
  assert.ok(s.problems.includes("This is a single-piece review: check it with output, not pieces."));
});

test("review(): multi-part tiers send pieces, never output, and check the answer with the pieces", async () => {
  const c = vx.cases.find((x) => x.id === "valid-3x2");
  const sent = [];
  const fakeFetch = async (url, init) => {
    sent.push({ url, body: JSON.parse(init.body) });
    return new Response(JSON.stringify({ review_id: "x", tier: "review-3x2", result: c.receipt.payload.result, votes: c.receipt.payload.votes, receipt: c.receipt }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const ref = new AgentReferee({ url: "https://agentreferee.ai", fetch: fakeFetch, publicKeys: keys });
  const r = await ref.review({ tier: "review-3x2", task: c.given.task, pieces: c.given.pieces, title: "Handoff v5" });
  assert.equal(r.check.ok, true, JSON.stringify(r.check.problems));
  assert.match(sent[0].url, /\/review-3x2$/);
  assert.deepEqual(Object.keys(sent[0].body).sort(), ["criteria", "panel", "pieces", "task", "title"].filter((k) => sent[0].body[k] !== undefined).sort());
  assert.equal("output" in sent[0].body, false);
  // Mistakes are caught before anything is sent (or paid for).
  for (const bad of [
    { tier: "review-3x2", task: c.given.task, output: "x" },
    { tier: "review-3x2", task: c.given.task, pieces: [{ text: "only one" }] },
    { tier: "review-3x3", task: c.given.task, pieces: c.given.pieces },
    { tier: "review-3", task: c.given.task, output: "x", pieces: c.given.pieces },
  ]) await assert.rejects(ref.review(bad), /Nothing was sent/);
  assert.equal(sent.length, 1);
});

test("odd receipts are refused without throwing: a null piece record, a built-in name as tier, a free or wrongly unanimous one", async () => {
  const c = vx.cases.find((x) => x.id === "valid-3x2");
  const p = c.receipt.payload;
  const nullRec = await verifyReviewOutcome({ ...p, pieces: [p.pieces[0], null] }, { task: c.given.task, pieces: c.given.pieces });
  assert.equal(nullRec.ok, false);
  assert.ok(nullRec.problems.includes("Piece 2's record in the receipt is malformed."), JSON.stringify(nullRec.problems));
  for (const tier of ["constructor", "toString", "__proto__"]) {
    const r = await verifyReviewOutcome({ ...p, tier });
    assert.deepEqual(r.problems, [`A review-multi-v1 receipt must be for a multi-part tier (review-3x2 or review-3x3), not ${tier}.`]);
  }
  const free = await verifyReviewOutcome({ ...p, funding: "free" }, { task: c.given.task, pieces: c.given.pieces });
  assert.ok(free.problems.includes("Multi-part reviews are paid only, but this receipt says it was free."));
  const unan = await verifyReviewOutcome({ ...p, result: { ...p.result, unanimous: true } }, { task: c.given.task, pieces: c.given.pieces });
  assert.ok(unan.problems.includes("The receipt's unanimous flag doesn't match the votes."));
  const nulls = await verifyReviewOutcome(c.receipt, { task: c.given.task, output: null, pieces: null }); // null means not given
  assert.equal(nulls.ok, true, JSON.stringify(nulls.problems));
});
